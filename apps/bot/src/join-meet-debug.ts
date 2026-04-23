import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';

export const DEFAULT_DEBUG_SCREENSHOT_ROOT = process.env.DEBUG_SCREENSHOT_ROOT ?? 'debug-screenshots';
export const DEFAULT_DEBUG_VIDEO_ROOT = process.env.DEBUG_VIDEO_ROOT ?? 'debug-videos';

export function getCorrelationIdLog(correlationId: string): string {
  return `[join-meet:${correlationId}]`;
}

export function resolveArtifactRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.join(process.cwd(), root);
}

function createTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

export async function createDebugScreenshotDir(
  sessionId: string,
  headless: boolean,
): Promise<string | undefined> {
  const timestamp = createTimestamp();
  const mode = headless ? 'headless' : 'headed';
  const directory = path.join(
    resolveArtifactRoot(DEFAULT_DEBUG_SCREENSHOT_ROOT),
    `${timestamp}-${mode}-${sessionId}`,
  );

  try {
    await mkdir(directory, { recursive: true });
    console.log(`[debug-screenshot] created directory: ${directory}`);
    return directory;
  } catch (error: unknown) {
    console.log(
      `[debug-screenshot] failed to create directory=${directory}: ${formatError(error)}; continuing without debug screenshots`,
    );
    return undefined;
  }
}

export async function saveDebugScreenshot(
  page: Page | undefined,
  screenshotDir: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (!page || !screenshotDir || page.isClosed()) {
    console.log(
      `[debug-screenshot] skipped label=${label} page=${Boolean(page)} dir=${Boolean(screenshotDir)} pageClosed=${page?.isClosed() ?? 'n/a'}`,
    );
    return undefined;
  }

  const filePath = path.join(screenshotDir, `${createTimestamp()}-${label}.png`);
  const htmlPath = filePath.replace(/\.png$/, '.html');
  const textPath = filePath.replace(/\.png$/, '.txt');

  console.log(`[debug-screenshot] capturing label=${label} png=${filePath}`);

  await page.bringToFront().catch((error: unknown) => {
    console.log(`[debug-screenshot] bringToFront failed label=${label}: ${formatError(error)}`);
    return undefined;
  });
  await page.waitForTimeout(500).catch((error: unknown) => {
    console.log(`[debug-screenshot] waitForTimeout failed label=${label}: ${formatError(error)}`);
    return undefined;
  });

  const html = await page.content().catch((error: unknown) => {
    console.log(`[debug-screenshot] page.content failed label=${label}: ${formatError(error)}`);
    return '';
  });
  const text = await page.locator('body').innerText().catch((error: unknown) => {
    console.log(`[debug-screenshot] body.innerText failed label=${label}: ${formatError(error)}`);
    return '';
  });

  await writeFile(htmlPath, html, 'utf8').catch((error: unknown) => {
    console.log(`[debug-screenshot] html write failed label=${label} path=${htmlPath}: ${formatError(error)}`);
    return undefined;
  });
  await writeFile(textPath, text, 'utf8').catch((error: unknown) => {
    console.log(`[debug-screenshot] text write failed label=${label} path=${textPath}: ${formatError(error)}`);
    return undefined;
  });
  await page
    .screenshot({
      path: filePath,
      fullPage: true,
      animations: 'disabled',
    })
    .catch((error: unknown) => {
      console.log(`[debug-screenshot] png capture failed label=${label} path=${filePath}: ${formatError(error)}`);
      return undefined;
    });

  console.log(`[debug-screenshot] finished label=${label} png=${filePath} html=${htmlPath} text=${textPath}`);

  return filePath;
}

export function attachBrowserErrorHandlers(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  correlationId: string,
): void {
  const log = getCorrelationIdLog(correlationId);

  browser.on('disconnected', () => {
    console.log(`${log} Browser has disconnected!`);
  });

  context.on('close', () => {
    console.log(`${log} Browser context has closed!`);
  });

  page.on('crash', () => {
    console.error(`${log} Page has crashed! ${page.url()}`);
  });

  page.on('close', () => {
    console.log(`${log} Page has closed! ${page.url()}`);
  });
}
