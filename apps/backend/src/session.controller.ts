import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  Req,
  HttpException,
  HttpStatus,
  Inject,
  Sse,
  Header,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  CreateSessionRequest,
  SessionStatus,
  SessionStatusUpdate,
} from '@meetingbot/shared';
import { SessionStore } from './session-store';
import { TranscriptStreamBridge } from './transcript-stream';
import { BotQueue } from './queue';

@Controller()
export class SessionController {
  constructor(
    @Inject(SessionStore) private readonly sessionStore: SessionStore,
    @Inject(TranscriptStreamBridge) private readonly transcriptBridge: TranscriptStreamBridge,
    @Inject(BotQueue) private readonly botQueue: BotQueue,
    @Inject('REDIS_URL') private readonly redisUrl: string,
    @Inject('INTERNAL_API_TOKEN') private readonly internalApiToken: string | undefined,
  ) {}

  @Get('health')
  health() {
    return { ok: true, service: 'backend', redisUrl: this.redisUrl };
  }

  @Post('sessions')
  async createSession(@Body() body: unknown) {
    const payload = this.parseCreateSessionRequest(body);
    const sessionId = randomUUID();
    const session = this.sessionStore.createSession(sessionId, payload);

    this.transcriptBridge.ensureSession(sessionId);
    try {
      await this.botQueue.enqueue({ sessionId, ...payload });
    } catch (error) {
      this.sessionStore.updateStatus(sessionId, 'FAILED', {
        error: error instanceof Error ? error.message : 'Failed to enqueue bot job.',
      });
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to enqueue bot job.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return { session };
  }

  @Get('sessions/:sessionId')
  getSession(@Param('sessionId') sessionId: string) {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new HttpException('Session not found.', HttpStatus.NOT_FOUND);
    }
    return { session };
  }

  @Get('sessions/:sessionId/status')
  getSessionStatus(@Param('sessionId') sessionId: string) {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new HttpException('Session not found.', HttpStatus.NOT_FOUND);
    }
    return {
      sessionId: session.sessionId,
      status: session.status,
      updatedAt: session.updatedAt,
      error: session.error ?? null,
      attemptsMade: session.attemptsMade,
    };
  }

  @Get('sessions/:sessionId/events')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  streamEvents(
    @Param('sessionId') sessionId: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    this.transcriptBridge.ensureSession(session.sessionId);

    // Set SSE headers and flush
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial session state
    this.writeSse(res, 'session', session);

    // Subscribe to events
    const unsubscribe = this.sessionStore.subscribe(session.sessionId, (event) => {
      if (event.type === 'status') {
        this.writeSse(res, 'status', event.session);
        return;
      }
      this.writeSse(res, 'transcript', {
        sessionId: event.session.sessionId,
        chunk: event.chunk,
        status: event.session.status,
      });
    });

    const heartbeat = setInterval(() => {
      this.writeSse(res, 'heartbeat', { ok: true });
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  @Post('internal/sessions/:sessionId/status')
  updateInternalStatus(
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (!this.isAuthorized(req.headers.authorization)) {
      throw new HttpException('Unauthorized.', HttpStatus.UNAUTHORIZED);
    }

    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new HttpException('Session not found.', HttpStatus.NOT_FOUND);
    }

    const payload = this.parseSessionStatusUpdate(body);
    const updatedSession = this.sessionStore.updateStatus(sessionId, payload.status, {
      joinedAt: payload.joinedAt,
      leftAt: payload.leftAt,
      error: payload.error,
      attemptsMade: payload.attemptsMade,
    });

    if (!updatedSession) {
      throw new HttpException('Session not found.', HttpStatus.NOT_FOUND);
    }

    return { session: updatedSession };
  }

  // ── Helpers ──

  private writeSse(res: Response, event: string, payload: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private isAuthorized(authorizationHeader: string | undefined): boolean {
    if (!this.internalApiToken) return true;
    return authorizationHeader === `Bearer ${this.internalApiToken}`;
  }

  private parseCreateSessionRequest(body: unknown): CreateSessionRequest {
    if (!this.isRecord(body)) {
      throw new HttpException('Expected a JSON object body.', HttpStatus.BAD_REQUEST);
    }

    const meetUrl = this.requireString(body.meetUrl, 'meetUrl');
    const parsedUrl = new URL(meetUrl);
    if (!/^meet\.google\.com$/i.test(parsedUrl.hostname)) {
      throw new HttpException('meetUrl must point to meet.google.com.', HttpStatus.BAD_REQUEST);
    }

    return {
      meetUrl,
      botDisplayName: this.requireString(body.botDisplayName, 'botDisplayName'),
      joinTimeoutMs: this.optionalNumber(body.joinTimeoutMs, 'joinTimeoutMs', 1000),
      stayInMeetingMs: this.optionalNumber(body.stayInMeetingMs, 'stayInMeetingMs', 0),
      headless: this.optionalBoolean(body.headless, 'headless'),
    };
  }

  private parseSessionStatusUpdate(body: unknown): SessionStatusUpdate {
    if (!this.isRecord(body)) {
      throw new HttpException('Expected a JSON object body.', HttpStatus.BAD_REQUEST);
    }

    return {
      status: this.parseStatus(body.status),
      joinedAt: this.optionalString(body.joinedAt, 'joinedAt'),
      leftAt: this.optionalString(body.leftAt, 'leftAt'),
      error: this.optionalNullableString(body.error, 'error'),
      attemptsMade: this.optionalNumber(body.attemptsMade, 'attemptsMade', 0),
    };
  }

  private isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
  }

  private requireString(v: unknown, field: string): string {
    if (typeof v !== 'string' || !v.trim()) {
      throw new HttpException(`${field} is required.`, HttpStatus.BAD_REQUEST);
    }
    return v.trim();
  }

  private optionalNumber(v: unknown, field: string, min: number): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      throw new HttpException(`${field} must be a number >= ${min}.`, HttpStatus.BAD_REQUEST);
    }
    return v;
  }

  private optionalBoolean(v: unknown, field: string): boolean | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') {
      throw new HttpException(`${field} must be a boolean.`, HttpStatus.BAD_REQUEST);
    }
    return v;
  }

  private optionalString(v: unknown, field: string): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim()) {
      throw new HttpException(`${field} must be a non-empty string.`, HttpStatus.BAD_REQUEST);
    }
    return v.trim();
  }

  private optionalNullableString(v: unknown, field: string): string | null | undefined {
    if (v === undefined || v === null) return v as null | undefined;
    if (typeof v !== 'string') {
      throw new HttpException(`${field} must be a string or null.`, HttpStatus.BAD_REQUEST);
    }
    return v;
  }

  private parseStatus(v: unknown): SessionStatus {
    if (v === 'QUEUED' || v === 'JOINING' || v === 'RECORDING' || v === 'DONE' || v === 'FAILED') {
      return v;
    }
    throw new HttpException(
      'status must be one of QUEUED, JOINING, RECORDING, DONE, FAILED.',
      HttpStatus.BAD_REQUEST,
    );
  }
}
