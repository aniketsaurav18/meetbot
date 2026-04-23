export interface JoinMeetRequest {
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
