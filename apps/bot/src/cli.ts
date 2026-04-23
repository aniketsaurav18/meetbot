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
  const meetUrl = readArg('--url');
  const botDisplayName = readArg('--name') ?? 'Meeting Bot';
  const joinTimeoutMs = Number(readArg('--join-timeout-ms') ?? '45000');
  const stayInMeetingMs = Number(readArg('--stay-ms') ?? '10000');
  const headless = parseBoolArg('--headless', readArg('--headless'));

  if (!meetUrl) {
    throw new Error('Missing required --url argument.');
  }

  const result = await joinMeet({
    meetUrl,
    botDisplayName,
    joinTimeoutMs,
    stayInMeetingMs,
    headless,
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.status !== 'JOINED') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown CLI error.';
  console.error(message);
  process.exitCode = 1;
});
