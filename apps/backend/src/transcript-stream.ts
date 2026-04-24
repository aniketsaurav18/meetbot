import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import IORedis from 'ioredis';
import type { TranscriptChunk } from '@meetingbot/shared';
import { SessionStore } from './session-store';

type StreamEntry = [id: string, fields: string[]];
type StreamResponse = [streamName: string, entries: StreamEntry[]][];

type SessionStreamState = {
  active: boolean;
  reader: IORedis;
  loop: Promise<void>;
  lastId: string;
};

@Injectable()
export class TranscriptStreamBridge {
  private readonly sessions = new Map<string, SessionStreamState>();
  private readonly streamPrefix = process.env.TRANSCRIPT_STREAM_PREFIX ?? 'transcript';

  constructor(
    private readonly redisUrl: string,
    private readonly sessionStore: SessionStore,
  ) {}

  ensureSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      return;
    }

    const reader = new IORedis(this.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    const state: SessionStreamState = {
      active: true,
      reader,
      loop: Promise.resolve(),
      lastId: '0-0',
    };

    state.loop = this.consume(sessionId, state);
    this.sessions.set(sessionId, state);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (state) => {
        state.active = false;
        await state.reader.quit().catch(() => state.reader.disconnect());
        await state.loop.catch(() => undefined);
      }),
    );
    this.sessions.clear();
  }

  private async consume(sessionId: string, state: SessionStreamState): Promise<void> {
    const streamKey = `${this.streamPrefix}:${sessionId}`;

    while (state.active) {
      try {
        const response = (await state.reader.xread(
          'BLOCK',
          5000,
          'STREAMS',
          streamKey,
          state.lastId,
        )) as StreamResponse | null;

        if (!response) {
          continue;
        }

        for (const [, entries] of response) {
          for (const [streamId, flatFields] of entries) {
            state.lastId = streamId;
            const fields = toRecord(flatFields);
            const text = fields.text?.trim();

            if (!text) {
              continue;
            }

            const chunk: TranscriptChunk = {
              id: streamId,
              streamId,
              text,
              receivedAt: fields.receivedAt ?? new Date().toISOString(),
              sequence: toNumber(fields.sequence),
            };

            this.sessionStore.appendTranscript(sessionId, chunk);
          }
        }
      } catch (error) {
        if (!state.active) {
          break;
        }

        console.error(`[backend] transcript stream failed for ${sessionId}:`, error);
        await delay(1000);
      }
    }
  }
}

function toRecord(values: string[]): Record<string, string> {
  const record: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key) {
      record[key] = value ?? '';
    }
  }

  return record;
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
