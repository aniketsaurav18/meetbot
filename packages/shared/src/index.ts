export interface JoinMeetRequest {
  sessionId?: string;
  meetUrl: string;
  botDisplayName: string;
  joinTimeoutMs?: number;
  stayInMeetingMs?: number;
  /** When set, overrides `HEADLESS` env (default: headless unless `HEADLESS=false`). */
  headless?: boolean;
}

export interface JoinMeetResult {
  sessionId: string;
  status: 'JOINED' | 'FAILED';
  message: string;
  joinedAt?: string;
  leftAt?: string;
}

export type SessionStatus = 'QUEUED' | 'JOINING' | 'RECORDING' | 'DONE' | 'FAILED';

export interface CreateSessionRequest {
  meetUrl: string;
  botDisplayName: string;
  joinTimeoutMs?: number;
  stayInMeetingMs?: number;
  headless?: boolean;
}

export interface JoinMeetingJob extends CreateSessionRequest {
  sessionId: string;
}

export interface TranscriptChunk {
  id: string;
  text: string;
  receivedAt: string;
  sequence?: number;
  streamId?: string;
}

export interface SessionRecord {
  sessionId: string;
  meetUrl: string;
  botDisplayName: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  joinedAt?: string;
  leftAt?: string;
  error?: string;
  attemptsMade: number;
  transcript: TranscriptChunk[];
}

export interface SessionStatusUpdate {
  status: SessionStatus;
  joinedAt?: string;
  leftAt?: string;
  error?: string | null;
  attemptsMade?: number;
}
