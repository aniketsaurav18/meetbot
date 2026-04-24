import { Injectable } from '@nestjs/common';
import IORedis from 'ioredis';
import { Queue, type JobsOptions } from 'bullmq';
import type { JoinMeetingJob } from '@meetingbot/shared';

export const queueName = process.env.BOT_QUEUE_NAME ?? 'meetingbot-join';

@Injectable()
export class BotQueue {
  private readonly connection: IORedis;
  private readonly queue: Queue<JoinMeetingJob>;

  constructor(private readonly redisUrl: string) {
    this.connection = new IORedis(this.redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue<JoinMeetingJob>(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    });
  }

  async enqueue(job: JoinMeetingJob, options: JobsOptions = {}): Promise<void> {
    await this.queue.add(job.sessionId, job, options);
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
