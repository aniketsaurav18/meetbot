import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';

export type RecorderInjectionConfig = {
  wsUrl: string;
  sessionId: string;
  chunkMs?: number;
  mimeType?: string;
  language?: string;
  prompt?: string;
};

export function injectRecorderScript(page: Page, config: RecorderInjectionConfig) {
  const recorderScript = fs.readFileSync(path.join(__dirname, 'scripts/recorder.js'), 'utf8');
  return page.evaluate(
    ({ script, recorderConfig }) => {
      (window as typeof window & { __MEETINGBOT_RECORDER_CONFIG__?: unknown }).__MEETINGBOT_RECORDER_CONFIG__ =
        recorderConfig;
      return globalThis.eval(script);
    },
    { script: recorderScript, recorderConfig: config },
  );
}