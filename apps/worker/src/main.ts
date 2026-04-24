import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import type { JoinMeetingJob, JoinMeetResult, SessionStatusUpdate } from '@meetingbot/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const queueName = process.env.BOT_QUEUE_NAME ?? 'meetingbot-join';
const workerConcurrency = Number(process.env.BOT_WORKER_CONCURRENCY ?? '1');
const backendInternalUrl = stripTrailingSlash(process.env.BACKEND_INTERNAL_URL ?? 'http://backend:3000/internal');
const internalApiToken = process.env.INTERNAL_API_TOKEN;
const botImage = process.env.BOT_IMAGE ?? 'meetingbot-bot:latest';
const dockerNetwork = process.env.DOCKER_NETWORK ?? 'meetingbot';
const transcriptionWsUrl = process.env.TRANSCRIPTION_WS_URL ?? 'ws://transcription:6666/ws';
const browserExecutablePath = process.env.BROWSER_EXECUTABLE_PATH ?? '/usr/bin/google-chrome';
const defaultHeadless = process.env.HEADLESS ?? 'true';
const screenshotVolume = process.env.BOT_SCREENSHOT_VOLUME ?? 'meetingbot_debug-screenshots';
const videoVolume = process.env.BOT_VIDEO_VOLUME ?? 'meetingbot_debug-videos';
const screenshotRoot = process.env.DEBUG_SCREENSHOT_ROOT ?? '/tmp/meetingbot/debug-screenshots';
const videoRoot = process.env.DEBUG_VIDEO_ROOT ?? '/tmp/meetingbot/debug-videos';

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

async function bootstrap(): Promise<void> {
  const worker = new Worker<JoinMeetingJob>(
    queueName,
    async (job) => {
      const attemptsMade = job.attemptsMade + 1;

      await updateSession(job.data.sessionId, {
        status: 'JOINING',
        attemptsMade,
        error: null,
      });

      const result = await runBotContainer(job.data);
      if (result.status === 'FAILED') {
        await updateSession(job.data.sessionId, {
          status: 'FAILED',
          attemptsMade,
          error: result.message,
        });
        return result;
      }

      await updateSession(job.data.sessionId, {
        status: 'DONE',
        joinedAt: result.joinedAt,
        leftAt: result.leftAt,
        attemptsMade,
        error: null,
      });

      return result;
    },
    {
      connection,
      concurrency: workerConcurrency,
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) {
      return;
    }

    const attemptsAllowed = job.opts.attempts ?? 1;
    const attemptsMade = job.attemptsMade;
    const willRetry = attemptsMade < attemptsAllowed;

    updateSession(job.data.sessionId, {
      status: willRetry ? 'QUEUED' : 'FAILED',
      attemptsMade,
      error: error.message,
    }).catch((updateError) => {
      console.error('[worker] failed to update session status after job failure:', updateError);
    });
  });

  worker.on('error', (error) => {
    console.error('[worker] worker error:', error);
  });

  console.log(`[worker] listening for queue ${queueName}`);
  registerShutdownHandlers(worker);
}

async function runBotContainer(job: JoinMeetingJob): Promise<JoinMeetResult> {
  const containerName = `meetingbot-bot-${job.sessionId}-${randomUUID().slice(0, 8)}`;
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    dockerNetwork,
    '-e',
    `BACKEND_INTERNAL_URL=${backendInternalUrl}`,
    '-e',
    `TRANSCRIPTION_WS_URL=${transcriptionWsUrl}`,
    '-e',
    `BROWSER_EXECUTABLE_PATH=${browserExecutablePath}`,
    '-e',
    `HEADLESS=${defaultHeadless}`,
    '-e',
    `DEBUG_SCREENSHOT_ROOT=${screenshotRoot}`,
    '-e',
    `DEBUG_VIDEO_ROOT=${videoRoot}`,
    '-e',
    `INTERNAL_API_TOKEN=${internalApiToken ?? ''}`,
    '-v',
    `${screenshotVolume}:${screenshotRoot}`,
    '-v',
    `${videoVolume}:${videoRoot}`,
    botImage,
    '--session-id',
    job.sessionId,
    '--url',
    job.meetUrl,
    '--name',
    job.botDisplayName,
    '--join-timeout-ms',
    String(job.joinTimeoutMs ?? 45000),
    '--stay-ms',
    String(job.stayInMeetingMs ?? 10000),
  ];

  if (typeof job.headless === 'boolean') {
    args.push('--headless', String(job.headless));
  }

  const result = await runCommand(args, true);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const parsedResult = parseJoinMeetResult(combinedOutput);

  if (parsedResult) {
    return parsedResult;
  }

  if (result.exitCode !== 0) {
    throw new Error(combinedOutput.trim() || 'Bot container failed without output.');
  }

  throw new Error('Bot container finished without emitting a valid result.');
}

async function updateSession(sessionId: string, payload: SessionStatusUpdate): Promise<void> {
  const response = await fetch(`${backendInternalUrl}/sessions/${sessionId}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(internalApiToken ? { authorization: `Bearer ${internalApiToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Backend status update failed (${response.status}): ${body}`);
  }
}

function parseJoinMeetResult(output: string): JoinMeetResult | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as JoinMeetResult;
      if (parsed && typeof parsed.sessionId === 'string' && typeof parsed.status === 'string') {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function runCommand(
  args: string[],
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // child.stdout.on('data', (chunk: Buffer | string) => {
    //   const text = chunk.toString();
    //   stdout += text;
    //   process.stdout.write(text);
    // });

    // child.stderr.on('data', (chunk: Buffer | string) => {
    //   const text = chunk.toString();
    //   stderr += text;
    //   process.stderr.write(text);
    // });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (exitCode) => {
      const code = exitCode ?? 1;
      if (!allowFailure && code !== 0) {
        reject(new Error(stderr || stdout || `docker ${args[0]} failed with exit code ${code}`));
        return;
      }

      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function registerShutdownHandlers(worker: Worker<JoinMeetingJob>): void {
  const shutdown = async () => {
    console.log('[worker] shutting down');
    await worker.close();
    await connection.quit().catch(() => connection.disconnect());
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown().catch((error) => {
        console.error('[worker] shutdown failed:', error);
        process.exit(1);
      });
    });
  }
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : 'Unknown worker bootstrap error.';
  console.error(message);
  process.exit(1);
});
