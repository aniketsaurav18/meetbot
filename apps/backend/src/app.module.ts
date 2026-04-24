import { Module } from '@nestjs/common';
import { SessionController } from './session.controller';
import { SessionStore } from './session-store';
import { TranscriptStreamBridge } from './transcript-stream';
import { BotQueue } from './queue';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const internalApiToken = process.env.INTERNAL_API_TOKEN;

@Module({
  controllers: [SessionController],
  providers: [
    SessionStore,
    {
      provide: BotQueue,
      useFactory: () => new BotQueue(redisUrl),
    },
    {
      provide: TranscriptStreamBridge,
      useFactory: (sessionStore: SessionStore) => new TranscriptStreamBridge(redisUrl, sessionStore),
      inject: [SessionStore],
    },
    {
      provide: 'REDIS_URL',
      useValue: redisUrl,
    },
    {
      provide: 'INTERNAL_API_TOKEN',
      useValue: internalApiToken,
    },
  ],
})
export class AppModule {}
