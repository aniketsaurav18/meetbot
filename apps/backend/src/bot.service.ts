import { Injectable } from '@nestjs/common';
import { joinMeet } from '@meetingbot/bot';
import type { JoinMeetRequest, JoinMeetResult } from '@meetingbot/shared';

@Injectable()
export class BotService {
  async join(request: JoinMeetRequest): Promise<JoinMeetResult> {
    return joinMeet(request);
  }
}
