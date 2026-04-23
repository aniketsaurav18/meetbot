import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import cors from 'cors';
import express, { type Response } from 'express';
import type { CreateSessionRequest, SessionStatus, SessionStatusUpdate } from '@meetingbot/shared';
import { BotQueue } from './queue';
import { SessionStore } from './session-store';
import { TranscriptStreamBridge } from './transcript-stream';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const internalApiToken = process.env.INTERNAL_API_TOKEN;

const app = express();
const sessionStore = new SessionStore();
const transcriptBridge = new TranscriptStreamBridge(redisUrl, sessionStore);
const botQueue = new BotQueue(redisUrl);

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'backend',
    redisUrl,
  });
});

app.post('/sessions', async (req, res) => {
  try {
    const payload = parseCreateSessionRequest(req.body);
    const sessionId = randomUUID();
    const session = sessionStore.createSession(sessionId, payload);

    transcriptBridge.ensureSession(sessionId);
    try {
      await botQueue.enqueue({
        sessionId,
        ...payload,
      });
    } catch (error) {
      sessionStore.updateStatus(sessionId, 'FAILED', {
        error: error instanceof Error ? error.message : 'Failed to enqueue bot job.',
      });
      throw error;
    }

    res.status(202).json({ session });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get('/sessions/:sessionId', (req, res) => {
  const session = sessionStore.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  res.json({ session });
});

app.get('/sessions/:sessionId/status', (req, res) => {
  const session = sessionStore.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    updatedAt: session.updatedAt,
    error: session.error ?? null,
    attemptsMade: session.attemptsMade,
  });
});

app.get('/sessions/:sessionId/events', (req, res) => {
  const session = sessionStore.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  transcriptBridge.ensureSession(session.sessionId);
  setupSse(res);
  writeSse(res, 'session', session);

  const unsubscribe = sessionStore.subscribe(session.sessionId, (event) => {
    if (event.type === 'status') {
      writeSse(res, 'status', event.session);
      return;
    }

    writeSse(res, 'transcript', {
      sessionId: event.session.sessionId,
      chunk: event.chunk,
      status: event.session.status,
    });
  });

  const heartbeat = setInterval(() => {
    writeSse(res, 'heartbeat', { ok: true });
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

app.post('/internal/sessions/:sessionId/status', (req, res) => {
  if (!isAuthorizedInternalRequest(req.headers.authorization)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const session = sessionStore.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  try {
    const payload = parseSessionStatusUpdate(req.body);
    const updatedSession = sessionStore.updateStatus(req.params.sessionId, payload.status, {
      joinedAt: payload.joinedAt,
      leftAt: payload.leftAt,
      error: payload.error,
      attemptsMade: payload.attemptsMade,
    });

    if (!updatedSession) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    res.json({ session: updatedSession });
  } catch (error) {
    sendError(res, error, 400);
  }
});

const server = http.createServer(app);

server.listen(port, host, () => {
  console.log(`[backend] listening on http://${host}:${port}`);
});

registerShutdownHandlers(server);

function parseCreateSessionRequest(body: unknown): CreateSessionRequest {
  if (!isRecord(body)) {
    throw new Error('Expected a JSON object body.');
  }

  const meetUrl = getRequiredString(body.meetUrl, 'meetUrl');
  const parsedUrl = new URL(meetUrl);
  if (!/^meet\.google\.com$/i.test(parsedUrl.hostname)) {
    throw new Error('meetUrl must point to meet.google.com.');
  }

  return {
    meetUrl,
    botDisplayName: getRequiredString(body.botDisplayName, 'botDisplayName'),
    joinTimeoutMs: getOptionalNumber(body.joinTimeoutMs, 'joinTimeoutMs', 1000),
    stayInMeetingMs: getOptionalNumber(body.stayInMeetingMs, 'stayInMeetingMs', 0),
    headless: getOptionalBoolean(body.headless, 'headless'),
  };
}

function getRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function getOptionalNumber(value: unknown, field: string, min: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${field} must be a number greater than or equal to ${min}.`);
  }

  return value;
}

function getOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean.`);
  }

  return value;
}

function parseSessionStatusUpdate(body: unknown): SessionStatusUpdate {
  if (!isRecord(body)) {
    throw new Error('Expected a JSON object body.');
  }

  return {
    status: getSessionStatus(body.status),
    joinedAt: getOptionalString(body.joinedAt, 'joinedAt'),
    leftAt: getOptionalString(body.leftAt, 'leftAt'),
    error: getOptionalNullableString(body.error, 'error'),
    attemptsMade: getOptionalNumber(body.attemptsMade, 'attemptsMade', 0),
  };
}

function setupSse(res: Response): void {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();
}

function writeSse(res: Response, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendError(res: Response, error: unknown, statusCode: number): void {
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  res.status(statusCode).json({ error: message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getSessionStatus(value: unknown): SessionStatus {
  if (value === 'QUEUED' || value === 'JOINING' || value === 'RECORDING' || value === 'DONE' || value === 'FAILED') {
    return value;
  }

  throw new Error('status must be one of QUEUED, JOINING, RECORDING, DONE, FAILED.');
}

function getOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function getOptionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) {
    return value as null | undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string or null.`);
  }

  return value;
}

function isAuthorizedInternalRequest(authorizationHeader: string | undefined): boolean {
  if (!internalApiToken) {
    return true;
  }

  return authorizationHeader === `Bearer ${internalApiToken}`;
}

function registerShutdownHandlers(serverInstance: http.Server): void {
  const shutdown = async () => {
    console.log('[backend] shutting down');
    serverInstance.close();
    await Promise.all([botQueue.close(), transcriptBridge.close()]);
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown().catch((error) => {
        console.error('[backend] shutdown failed:', error);
        process.exit(1);
      });
    });
  }
}
