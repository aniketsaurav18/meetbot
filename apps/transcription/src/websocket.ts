import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export type ChunkMetadata = {
  sessionId?: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  streamKey?: string;
};

export type ChunkRequest = ChunkMetadata & {
  source: 'http' | 'ws';
  connectionId?: string;
  sequence: number;
  audio: Buffer;
};

export type TranscriptResult = {
  text: string;
  streamId?: string;
  streamKey: string;
};

export type ConnectionContext = ChunkMetadata & {
  connectionId: string;
  nextSequence: number;
  pending: Promise<void>;
};

export interface TranscriptionProcessor {
  (request: ChunkRequest): Promise<TranscriptResult>;
}

export const wsPath = process.env.TRANSCRIPTION_WS_PATH ?? '/ws';

const socketContexts = new WeakMap<WebSocket, ConnectionContext>();
let processAudioChunkFn: TranscriptionProcessor | null = null;
let resolveStreamKeyFn: ((metadata: ChunkMetadata) => string) | null = null;
let defaultLanguage: string | undefined;
let defaultPrompt: string | undefined;

export function initWebSocket(
  processAudioChunk: TranscriptionProcessor,
  resolveStreamKey: (metadata: ChunkMetadata) => string,
  lang?: string,
  prompt?: string,
): void {
  processAudioChunkFn = processAudioChunk;
  resolveStreamKeyFn = resolveStreamKey;
  defaultLanguage = lang;
  defaultPrompt = prompt;
}

export function createWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = getRequestUrl(req);
      if (url.pathname !== wsPath) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const context = buildConnectionContext(req);
        socketContexts.set(ws, context);
        wss.emit('connection', ws, req);
      });
    } catch (error) {
      console.error('[transcription] WebSocket upgrade failed:', error);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const context = socketContexts.get(ws);
    if (!ws || !context) {
      ws?.close(1011, 'Missing connection context');
      return;
    }

    safeSend(ws, {
      type: 'ready',
      connectionId: context.connectionId,
      sessionId: context.sessionId ?? null,
      streamKey: resolveStreamKeyFn!(context),
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        enqueueBinaryChunk(ws, context, toBuffer(data));
        return;
      }

      const text = toBuffer(data).toString('utf8').trim();
      if (!text) {
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        safeSend(ws, {
          type: 'error',
          error: 'Expected JSON text messages or binary audio frames.',
        });
        return;
      }

      handleSocketControlMessage(ws, context, payload);
    });

    ws.on('close', () => {
      context.pending.catch(() => undefined);
    });
  });

  return wss;
}

export function buildConnectionContext(req: IncomingMessage): ConnectionContext {
  const url = getRequestUrl(req);

  return {
    connectionId: randomUUID(),
    nextSequence: 1,
    pending: Promise.resolve(),
    sessionId: firstDefined(
      url.searchParams.get('sessionId'),
      headerValue(req.headers['x-session-id']),
    ),
    mimeType: firstDefined(
      url.searchParams.get('mimeType'),
      headerValue(req.headers['x-mime-type']),
    ),
    language: firstDefined(
      url.searchParams.get('language'),
      headerValue(req.headers['x-language']),
      defaultLanguage,
    ),
    prompt: firstDefined(
      url.searchParams.get('prompt'),
      headerValue(req.headers['x-prompt']),
      defaultPrompt,
    ),
    streamKey: firstDefined(
      url.searchParams.get('streamKey'),
      headerValue(req.headers['x-stream-key']),
    ),
  };
}

function handleSocketControlMessage(ws: WebSocket, context: ConnectionContext, payload: unknown): void {
  if (!isRecord(payload)) {
    safeSend(ws, {
      type: 'error',
      error: 'Socket message must be an object.',
    });
    return;
  }

  const type = typeof payload.type === 'string' ? payload.type : 'message';
  if (type === 'ping') {
    safeSend(ws, { type: 'pong', connectionId: context.connectionId });
    return;
  }

  if (type === 'start' || type === 'metadata' || type === 'config') {
    updateConnectionMetadata(context, payload);
    safeSend(ws, {
      type: 'ack',
      action: 'metadata',
      connectionId: context.connectionId,
      sessionId: context.sessionId ?? null,
      streamKey: resolveStreamKeyFn!(context),
    });
    return;
  }

  if (type === 'chunk') {
    updateConnectionMetadata(context, payload);
    const base64Audio = getFirstString(payload.data, payload.audio, payload.chunk);

    if (!base64Audio) {
      safeSend(ws, {
        type: 'error',
        error: 'Chunk messages must include a base64 audio payload in data, audio, or chunk.',
      });
      return;
    }

    enqueueBinaryChunk(
      ws,
      context,
      Buffer.from(base64Audio, 'base64'),
      typeof payload.sequence === 'number' ? payload.sequence : undefined,
    );
    return;
  }

  if (type === 'end') {
    safeSend(ws, {
      type: 'ack',
      action: 'end',
      connectionId: context.connectionId,
    });
    return;
  }

  safeSend(ws, {
    type: 'error',
    error: `Unsupported socket message type: ${type}`,
  });
}

function updateConnectionMetadata(context: ConnectionContext, payload: Record<string, unknown>): void {
  context.sessionId = firstDefined(getOptionalString(payload.sessionId), context.sessionId);
  context.mimeType = firstDefined(getOptionalString(payload.mimeType), context.mimeType);
  context.language = firstDefined(getOptionalString(payload.language), context.language, defaultLanguage);
  context.prompt = firstDefined(getOptionalString(payload.prompt), context.prompt, defaultPrompt);
  context.streamKey = firstDefined(getOptionalString(payload.streamKey), context.streamKey);
}

function enqueueBinaryChunk(
  ws: WebSocket,
  context: ConnectionContext,
  audio: Buffer,
  explicitSequence?: number,
): void {
  const sequence = explicitSequence ?? context.nextSequence++;

  context.pending = context.pending
    .then(async () => {
      if (!processAudioChunkFn) {
        throw new Error('Transcription processor not initialized');
      }

      const result = await processAudioChunkFn({
        source: 'ws',
        connectionId: context.connectionId,
        sequence,
        audio,
        sessionId: context.sessionId,
        mimeType: context.mimeType,
        language: context.language,
        prompt: context.prompt,
        streamKey: context.streamKey,
      });

      safeSend(ws, {
        type: 'transcript',
        connectionId: context.connectionId,
        sequence,
        sessionId: context.sessionId ?? null,
        ...result,
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Chunk processing failed.';
      console.error('[transcription] chunk failed:', message);
      safeSend(ws, {
        type: 'error',
        connectionId: context.connectionId,
        sequence,
        error: message,
      });
    });
}

export function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== 1) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data.map((item) => toBuffer(item)));
  }

  return Buffer.from(data);
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return emptyToUndefined(value);
  }

  if (Array.isArray(value)) {
    return emptyToUndefined(value[0]);
  }

  return undefined;
}

function firstDefined(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? emptyToUndefined(value) : undefined;
}

function getFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}