export interface JoinMeetRequest {
  meetUrl: string;
  botDisplayName: string;
  joinTimeoutMs?: number;
  stayInMeetingMs?: number;
}

export interface JoinMeetResult {
  sessionId: string;
  status: 'JOINED' | 'FAILED';
  message: string;
  joinedAt?: string;
  leftAt?: string;
}
