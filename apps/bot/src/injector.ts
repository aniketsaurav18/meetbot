import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';

export type RecorderInjectionConfig = {
  sessionId: string;
  chunkMs?: number;
  mimeType?: string;
};

export async function injectRecorderScript(page: Page, config: RecorderInjectionConfig): Promise<void> {
  const recorderScript = fs.readFileSync(path.join(__dirname, 'scripts/recorder.js'), 'utf8');
  await page.evaluate(
    ({ script, recorderConfig }) => {
      (window as typeof window & { __MEETINGBOT_RECORDER_CONFIG__?: unknown }).__MEETINGBOT_RECORDER_CONFIG__ =
        recorderConfig;
      globalThis.eval(script);
    },
    { script: recorderScript, recorderConfig: config },
  );

  await page.evaluate(() => {
    const startRecordAudio = (window as typeof window & { startRecordAudio?: () => Promise<void> }).startRecordAudio;
    if (typeof startRecordAudio !== 'function') {
      throw new Error('Recorder script did not expose startRecordAudio.');
    }

    return startRecordAudio();
  });
}