import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { flushDebugAudioState } from './debug-audio';

export type ChunkMetadata = {
  sessionId?: string;
  mimeType?: string;
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

export function initWebSocket(
  processAudioChunk: TranscriptionProcessor,
  resolveStreamKey: (metadata: ChunkMetadata) => string,
): void {
  processAudioChunkFn = processAudioChunk;
  resolveStreamKeyFn = resolveStreamKey;
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

      console.log(
        `[transcription] upgrade request path=${url.pathname} sessionId=${url.searchParams.get('sessionId') ?? 'none'} host=${req.headers.host ?? 'unknown'}`,
      );

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

    console.log(
      `[transcription] ws connected connectionId=${context.connectionId} sessionId=${context.sessionId ?? 'none'} mimeType=${context.mimeType ?? 'unknown'}`,
    );

    safeSend(ws, {
      type: 'ready',
      connectionId: context.connectionId,
      sessionId: context.sessionId ?? null,
      streamKey: resolveStreamKeyFn!(context),
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        console.log(
          `[transcription] ws binary chunk connectionId=${context.connectionId} sessionId=${context.sessionId ?? 'none'} sequence=${context.nextSequence} bytes=${toBuffer(data).length}`,
        );
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

      console.log(
        `[transcription] ws control message connectionId=${context.connectionId} sessionId=${context.sessionId ?? 'none'} type=${typeof payload === 'object' && payload && 'type' in payload && typeof payload.type === 'string' ? payload.type : 'message'}`,
      );
      handleSocketControlMessage(ws, context, payload);
    });

    ws.on('close', (code, reason) => {
      console.log(
        `[transcription] ws closed connectionId=${context.connectionId} sessionId=${context.sessionId ?? 'none'} code=${code} reason=${reason.toString() || 'none'}`,
      );
      void context.pending
        .catch(() => undefined)
        .then(() =>
          flushDebugAudioState({
            connectionId: context.connectionId,
            sessionId: context.sessionId,
            mimeType: context.mimeType,
          }),
        );
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
  if (type === 'end') {
    context.sessionId = firstDefined(
      typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      context.sessionId,
    );

    void context.pending
      .catch(() => undefined)
      .then(() =>
        flushDebugAudioState({
          connectionId: context.connectionId,
          sessionId: context.sessionId,
          mimeType: context.mimeType,
        }),
      );
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

function enqueueBinaryChunk(
  ws: WebSocket,
  context: ConnectionContext,
  audio: Buffer,
): void {
  const sequence = context.nextSequence++;

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
        streamKey: context.streamKey,
      });

      console.log(
        `[transcription] chunk processed connectionId=${context.connectionId} sessionId=${context.sessionId ?? 'none'} sequence=${sequence} textLength=${result.text.length} streamKey=${result.streamKey}`,
      );

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}