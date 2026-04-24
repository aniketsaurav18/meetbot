import 'dotenv/config';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { closeRedis, connectRedis, redis } from './redis';
import {
  createWebSocketServer,
  initWebSocket,
  wsPath,
} from './websocket';
import { initTranscriptionDebugAudioDir } from './debug-audio';
import {
  healthPath,
  transcriptionModel,
  processAudioChunk,
  resolveStreamKey,
} from './transcription';

const port = Number(process.env.PORT ?? 6666);
const host = process.env.HOST ?? '0.0.0.0';

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unexpected request failure.';
    console.error('[transcription] HTTP request failed:', message);
    sendJson(res, 500, { ok: false, error: message });
  });
});

initWebSocket(processAudioChunk, resolveStreamKey);
const wss = createWebSocketServer(server);

async function bootstrap(): Promise<void> {
  await connectRedis();

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      void (async () => {
        try {
          console.log(`[transcription] listening on http://${host}:${port}`);
          console.log(`[transcription] websocket path ${wsPath}`);
          await initTranscriptionDebugAudioDir();
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
  });

  registerShutdownHandlers();
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = getRequestUrl(req);

  if (req.method === 'GET' && url.pathname === healthPath) {
    sendJson(res, 200, {
      ok: true,
      service: 'transcription',
      redis: redis.isOpen,
      model: transcriptionModel,
      wsPath,
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'Not found.',
  });
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function registerShutdownHandlers(): void {
  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`[transcription] received ${signal}, shutting down`);
    wss.close();
    server.close();
    await closeRedis();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error('[transcription] shutdown failed:', error);
      process.exit(1);
    });
  });

  process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error('[transcription] shutdown failed:', error);
      process.exit(1);
    });
  });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : 'Unknown bootstrap error.';
  console.error(message);
  process.exit(1);
});