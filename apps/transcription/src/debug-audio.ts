import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChunkRequest } from './websocket';

const debugAudioWindowMs = Math.max(1_000, Number(process.env.TRANSCRIPTION_DEBUG_AUDIO_WINDOW_MS ?? 10_000));

/** Read at use time so dotenv / Docker env are visible (avoids import-order bugs). */
function getTranscriptionDebugAudioDir(): string | undefined {
  return emptyToUndefined(process.env.TRANSCRIPTION_DEBUG_AUDIO_DIR);
}

/** Call once on server start: logs config and creates the root dir if debug is enabled. */
export async function initTranscriptionDebugAudioDir(): Promise<void> {
  const root = getTranscriptionDebugAudioDir();
  if (!root) {
    return;
  }
  try {
    await mkdir(root, { recursive: true });
    console.log(
      `[transcription] debug audio enabled: TRANSCRIPTION_DEBUG_AUDIO_DIR=${root} (window ${debugAudioWindowMs}ms)`,
    );
  } catch (error) {
    console.error('[transcription] debug audio: cannot create root directory:', error);
  }
}

export type DebugAudioFlushContext = {
  connectionId: string;
  sessionId?: string;
  mimeType?: string;
};

export function appendDebugAudioIfConfigured(request: ChunkRequest, mimeType: string): void {
  const root = getTranscriptionDebugAudioDir();
  if (!root) {
    return;
  }
  appendDebugAudio(root, request, mimeType);
}

function appendDebugAudio(rootDir: string, request: ChunkRequest, mimeType: string): void {
  void writeDebugBatchedFile(rootDir, request, mimeType, request.sequence, request.sequence, request.audio).catch(
    (error) => {
      console.error('[transcription] debug audio write failed:', error);
    },
  );
}

async function writeDebugBatchedFile(
  rootDir: string,
  request: ChunkRequest,
  mimeType: string,
  fromSeq: number,
  toSeq: number,
  data: Buffer,
): Promise<void> {
  if (data.length === 0) {
    return;
  }
  await mkdir(rootDir, { recursive: true });
  const ext = extensionForMimeType(mimeType);
  const sessionSegment = sanitizePathSegment(request.sessionId ?? 'unknown');
  const connectionSegment = sanitizePathSegment(request.connectionId ?? 'no-connection');
  const from = String(fromSeq).padStart(6, '0');
  const to = String(toSeq).padStart(6, '0');
  const fileName = `${from}-${to}-${Date.now()}.${ext}`;
  const dir = path.join(rootDir, sessionSegment, connectionSegment);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, data);
  console.log(`[transcription] debug audio saved ${filePath} (${data.length} bytes)`);
}

/** Debug chunks are saved immediately; this remains for the WebSocket close/end hook. */
export async function flushDebugAudioState(_ctx: DebugAudioFlushContext): Promise<void> {
  return;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'segment';
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();

  if (normalized.includes('webm')) {
    return 'webm';
  }
  if (normalized.includes('wav')) {
    return 'wav';
  }
  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'mp3';
  }
  if (normalized.includes('mp4')) {
    return 'mp4';
  }
  if (normalized.includes('ogg')) {
    return 'ogg';
  }
  if (normalized.includes('m4a')) {
    return 'm4a';
  }

  return 'webm';
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}
