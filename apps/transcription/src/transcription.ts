import Groq, { toFile } from 'groq-sdk';
import { redis } from './redis';
import { type ChunkMetadata, type ChunkRequest, type TranscriptResult } from './websocket';

export const healthPath = process.env.TRANSCRIPTION_HEALTH_PATH ?? '/health';
export const transcriptionModel =
  process.env.GROQ_TRANSCRIPTION_MODEL ??
  process.env.OPENAI_TRANSCRIPTION_MODEL ??
  'whisper-large-v3-turbo';
export const defaultLanguage = emptyToUndefined(process.env.OPENAI_TRANSCRIPTION_LANGUAGE);
export const defaultPrompt = emptyToUndefined(process.env.OPENAI_TRANSCRIPTION_PROMPT);

const transcriptStreamPrefix = process.env.TRANSCRIPT_STREAM_PREFIX ?? 'transcript';
const maxChunkBytes = Number(process.env.MAX_AUDIO_CHUNK_BYTES ?? 25 * 1024 * 1024);

if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is required for the transcription service.');
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function processAudioChunk(request: ChunkRequest): Promise<TranscriptResult> {
  if (!request.sessionId) {
    throw new Error('Missing sessionId for audio chunk.');
  }

  if (request.audio.length === 0) {
    throw new Error('Received an empty audio chunk.');
  }

  if (request.audio.length > maxChunkBytes) {
    throw new Error(`Audio chunk exceeded ${maxChunkBytes} bytes.`);
  }

  const mimeType = request.mimeType ?? 'audio/webm';
  const streamKey = resolveStreamKey(request);
  const transcription = await groq.audio.transcriptions.create({
    file: await toFile(request.audio, `chunk.${extensionForMimeType(mimeType)}`, {
      type: mimeType,
    }),
    model: transcriptionModel,
    response_format: 'json',
    ...(request.language ? { language: request.language } : {}),
    ...(request.prompt ? { prompt: request.prompt } : {}),
  });

  const text = transcription.text.trim();
  if (!text) {
    return { text: '', streamKey };
  }

  const streamId = await redis.sendCommand<string>([
    'XADD',
    streamKey,
    '*',
    'type',
    'transcript',
    'sessionId',
    request.sessionId,
    'text',
    text,
    'source',
    request.source,
    'sequence',
    String(request.sequence),
    'mimeType',
    mimeType,
    'language',
    request.language ?? '',
    'connectionId',
    request.connectionId ?? '',
    'receivedAt',
    new Date().toISOString(),
  ]);

  return {
    text,
    streamId,
    streamKey,
  };
}

export function resolveStreamKey(metadata: ChunkMetadata): string {
  if (metadata.streamKey) {
    return metadata.streamKey;
  }

  if (!metadata.sessionId) {
    return `${transcriptStreamPrefix}:unknown`;
  }
  return `${transcriptStreamPrefix}:${metadata.sessionId}`;
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