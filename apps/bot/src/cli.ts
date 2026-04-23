import { joinMeet } from './join-meet';

function readArg(flag: string): string | undefined {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }

  return process.argv[flagIndex + 1];
}

function parseBoolArg(flag: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1') {
    return true;
  }
  if (v === 'false' || v === '0') {
    return false;
  }
  throw new Error(`Invalid ${flag} value "${raw}". Use true or false.`);
}

async function main(): Promise<void> {
  const sessionId = readArg('--session-id');
  const meetUrl = readArg('--url');
  const botDisplayName = readArg('--name') ?? 'Meeting Bot';
  const joinTimeoutMs = Number(readArg('--join-timeout-ms') ?? '45000');
  const stayInMeetingMs = Number(readArg('--stay-ms') ?? '10000');
  const headless = parseBoolArg('--headless', readArg('--headless'));

  if (!meetUrl) {
    throw new Error('Missing required --url argument.');
  }

  const result = await joinMeet(
    {
      sessionId,
      meetUrl,
      botDisplayName,
      joinTimeoutMs,
      stayInMeetingMs,
      headless,
    },
    {
      onRecordingStarted: async ({ sessionId: activeSessionId, joinedAt }) => {
        await notifyRecordingStarted(activeSessionId, joinedAt);
      },
    },
  );

  console.log(JSON.stringify(result));

  if (result.status !== 'JOINED') {
    process.exitCode = 1;
  }
}

async function notifyRecordingStarted(sessionId: string, joinedAt: string): Promise<void> {
  const backendInternalUrl = process.env.BACKEND_INTERNAL_URL;
  if (!backendInternalUrl) {
    return;
  }

  const response = await fetch(`${backendInternalUrl}/sessions/${sessionId}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.INTERNAL_API_TOKEN
        ? { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      status: 'RECORDING',
      joinedAt,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to notify backend that recording started: ${response.status}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown CLI error.';
  console.error(message);
  process.exitCode = 1;
});
