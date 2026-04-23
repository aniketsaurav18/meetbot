import { EventEmitter } from 'node:events';
import type {
  CreateSessionRequest,
  SessionRecord,
  SessionStatus,
  TranscriptChunk,
} from '@meetingbot/shared';

export type SessionEvent =
  | { type: 'status'; session: SessionRecord }
  | { type: 'transcript'; session: SessionRecord; chunk: TranscriptChunk };

type SessionPatch = {
  joinedAt?: string;
  leftAt?: string;
  error?: string | null;
  attemptsMade?: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly emitters = new Map<string, EventEmitter>();

  createSession(sessionId: string, request: CreateSessionRequest): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      sessionId,
      meetUrl: request.meetUrl,
      botDisplayName: request.botDisplayName,
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      attemptsMade: 0,
      transcript: [],
    };

    this.sessions.set(sessionId, session);
    return this.snapshot(session);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.snapshot(session) : undefined;
  }

  updateStatus(sessionId: string, status: SessionStatus, patch: SessionPatch = {}): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    session.status = status;
    session.updatedAt = new Date().toISOString();
    if ('joinedAt' in patch) {
      session.joinedAt = patch.joinedAt;
    }
    if ('leftAt' in patch) {
      session.leftAt = patch.leftAt;
    }
    if ('error' in patch) {
      session.error = patch.error ?? undefined;
    }
    if ('attemptsMade' in patch && typeof patch.attemptsMade === 'number') {
      session.attemptsMade = patch.attemptsMade;
    }

    return this.emit(sessionId, { type: 'status', session: this.snapshot(session) });
  }

  appendTranscript(sessionId: string, chunk: TranscriptChunk): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    session.transcript.push(chunk);
    session.updatedAt = new Date().toISOString();

    if (session.status === 'QUEUED' || session.status === 'JOINING') {
      session.status = 'RECORDING';
    }

    return this.emit(sessionId, {
      type: 'transcript',
      session: this.snapshot(session),
      chunk,
    });
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const emitter = this.getEmitter(sessionId);
    emitter.on('event', listener);
    return () => {
      emitter.off('event', listener);
    };
  }

  private emit(sessionId: string, event: SessionEvent): SessionRecord {
    const emitter = this.getEmitter(sessionId);
    emitter.emit('event', event);
    return event.session;
  }

  private getEmitter(sessionId: string): EventEmitter {
    let emitter = this.emitters.get(sessionId);
    if (!emitter) {
      emitter = new EventEmitter();
      this.emitters.set(sessionId, emitter);
    }
    return emitter;
  }

  private snapshot(session: SessionRecord): SessionRecord {
    return {
      ...session,
      transcript: session.transcript.map((chunk) => ({ ...chunk })),
    };
  }
}
