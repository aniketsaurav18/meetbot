import { createClient, type RedisClientType } from 'redis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const redis = createClient({
  url: redisUrl,
});

export async function connectRedis(): Promise<void> {
  redis.on('error', (error: unknown) => {
    console.error('[transcription] Redis client error:', error);
  });

  await redis.connect();
}

export async function closeRedis(): Promise<void> {
  if (redis.isOpen) {
    await redis.close().catch(() => redis.destroy());
  }
}