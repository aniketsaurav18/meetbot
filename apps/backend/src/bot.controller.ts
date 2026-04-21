import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';
import type { JoinMeetResult } from '@meetingbot/shared';
import { BotService } from './bot.service';

class JoinBotDto {
  @IsUrl({
    protocols: ['https'],
    require_protocol: true,
  })
  meetUrl!: string;

  @IsString()
  botDisplayName!: string;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  joinTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  stayInMeetingMs?: number;
}

@Controller()
export class BotController {
  constructor(private readonly botService: BotService) {}

  @Get('health')
  getHealth(): { ok: true } {
    return { ok: true };
  }

  @Post('bot/join')
  async join(@Body() request: JoinBotDto): Promise<JoinMeetResult> {
    return this.botService.join(request);
  }
}
