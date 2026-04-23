import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';

export function injectRecorderScript(page: Page) {
  const recorderScript = fs.readFileSync(path.join(__dirname, 'scripts/recorder.js'), 'utf8');
  return page.evaluate(recorderScript);
}