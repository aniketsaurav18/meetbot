import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';

const SCREENSHOT_ROOT = process.env.DEBUG_SCREENSHOT_ROOT ?? 'debug-screenshots';
export const DEFAULT_DEBUG_VIDEO_ROOT = process.env.DEBUG_VIDEO_ROOT ?? 'debug-videos';

export function getCorrelationIdLog(id: string): string {
  return `[join-meet:${id}]`;
}

export function resolveArtifactRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.join(process.cwd(), root);
}

export async function createDebugScreenshotDir(sessionId: string): Promise<string | undefined> {
  const dir = path.join(resolveArtifactRoot(SCREENSHOT_ROOT), sessionId);
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

export async function saveDebugScreenshot(
  page: Page | undefined,
  dir: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (!page || !dir || page.isClosed()) return undefined;
  const filePath = path.join(dir, `${Date.now()}-${label}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return undefined;
  }
}

export function attachBrowserErrorHandlers(
  browser: Browser,
  _context: BrowserContext,
  page: Page,
  correlationId: string,
): void {
  const log = getCorrelationIdLog(correlationId);
  browser.on('disconnected', () => console.log(`${log} browser disconnected`));
  page.on('crash', () => console.error(`${log} page crashed`));
  page.on('close', () => console.log(`${log} page closed`));
}
