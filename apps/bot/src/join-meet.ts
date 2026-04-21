import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { chromium } from 'playwright-extra';
import type { Browser, BrowserContext, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { JoinMeetRequest, JoinMeetResult } from '@meetingbot/shared';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

const DEFAULT_JOIN_TIMEOUT_MS = 60000;
const DEFAULT_STAY_IN_MEETING_MS = 10_000;
const DEFAULT_BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH ?? '/usr/bin/google-chrome';
const DEFAULT_HEADLESS = process.env.HEADLESS !== 'false';
const DEFAULT_DEBUG_SCREENSHOT_ROOT = process.env.DEBUG_SCREENSHOT_ROOT ?? 'debug-screenshots';
const DEFAULT_DEBUG_VIDEO_ROOT = process.env.DEBUG_VIDEO_ROOT ?? 'debug-videos';
const FALLBACK_BROWSER_EXECUTABLE_PATHS = [
  DEFAULT_BROWSER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const NAME_INPUT_SELECTORS = [
  'input[aria-label="Your name"]',
  'input[placeholder="Your name"]',
  'input[type="text"]',
];
const DISMISS_SELECTORS = [
  'button[jsname="BOHaEe"]',
  'button[jsname="M2UYVd"]',
  'button[jsname="A5il2e"]',
  'button[aria-label="Close"]',
];
const MEDIA_PROMPT_DIALOG_SELECTOR = 'div[role="dialog"][aria-label="Do you want people to see and hear you in the meeting?"]';
const CONTINUE_WITHOUT_MEDIA_SELECTOR = 'button[jsname="IbE0S"]';
const MIC_TOGGLE_SELECTOR = 'div[jscontroller="t2mBxb"][data-anchor-id="hw0c9"]';
const CAMERA_TOGGLE_SELECTOR = 'div[jscontroller="bwqwSd"][data-anchor-id="psRWwc"]';
const JOIN_BUTTON_SELECTORS = [
  'button[data-promo-anchor-id="w5gBed"]',
  'button:has(span[jsname="V67aGc"])',
  'button[jscontroller="O626Fe"]',
  'button[jsname="Qx7uuf"]',
  'div[role="button"][jsname="Qx7uuf"]',
];
const IN_MEETING_SELECTORS = [
  'button[jsname="CQylAd"]',
  'button[aria-label*="Leave call"]',
  'button[aria-label*="Hang up"]',
  'button[data-tooltip-id*="hangup"]',
];

export async function joinMeet(request: JoinMeetRequest): Promise<JoinMeetResult> {
  const sessionId = randomUUID();
  const joinTimeoutMs = request.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
  const stayInMeetingMs = request.stayInMeetingMs ?? DEFAULT_STAY_IN_MEETING_MS;
  const headless = DEFAULT_HEADLESS;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let screenshotDir: string | undefined;

  try {
    ({ browser, context, page } = await createBrowserContext(request.meetUrl, sessionId, headless));

    screenshotDir = await createDebugScreenshotDir(sessionId, headless);

    await page.goto(request.meetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: joinTimeoutMs,
    });
    await saveDebugScreenshot(page, screenshotDir, 'after-goto');

    await preparePrejoinScreen(page, request.botDisplayName);
    await saveDebugScreenshot(page, screenshotDir, 'after-prejoin');
    await clickJoinButton(page, joinTimeoutMs);
    await saveDebugScreenshot(page, screenshotDir, 'after-join-click');
    await waitForJoinSuccess(page, joinTimeoutMs);
    await saveDebugScreenshot(page, screenshotDir, 'after-join-success');

    const joinedAt = new Date().toISOString();

    if (stayInMeetingMs > 0) {
      await delay(stayInMeetingMs);
    }

    await safeLeaveMeeting(page);
    await context.close();

    return {
      sessionId,
      status: 'JOINED',
      message: 'Bot joined the meeting successfully.',
      joinedAt,
      leftAt: new Date().toISOString(),
    };
  } catch (error) {
    const failureScreenshotPath = await saveDebugScreenshot(page, screenshotDir, 'failure');
    const baseMessage = error instanceof Error ? error.message : 'Unknown join failure.';
    const message = failureScreenshotPath
      ? `${baseMessage} Debug screenshot: ${failureScreenshotPath}`
      : baseMessage;

    return {
      sessionId,
      status: 'FAILED',
      message,
    };
  } finally {
    await browser?.close();
  }
}

async function createBrowserContext(
  meetUrl: string,
  correlationId: string,
  headless: boolean,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const size = { width: 1280, height: 720 };
  const executablePath = await resolveBrowserExecutablePath(correlationId);
  const debugVideoDir = resolveArtifactRoot(DEFAULT_DEBUG_VIDEO_ROOT);
  const browserArgs: string[] = [
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--enable-features=MediaRecorder',
    '--enable-audio-service-out-of-process',
    '--autoplay-policy=no-user-gesture-required',
  ];

  console.log(`${getCorrelationIdLog(correlationId)} Launching browser for google bot with executable ${executablePath}`);

  const browser = await launchBrowserWithTimeout(
    () =>
      chromium.launch({
        headless,
        args: browserArgs,
        ignoreDefaultArgs: ['--mute-audio'],
        executablePath,
      }),
    60_000,
    correlationId,
  );

  if (process.env.NODE_ENV === 'development') {
    await mkdir(debugVideoDir, { recursive: true });
  }

  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: size,
    ignoreHTTPSErrors: true,
    userAgent: DEFAULT_USER_AGENT,
    ...(process.env.NODE_ENV === 'development' && {
      recordVideo: {
        dir: debugVideoDir,
        size,
      },
    }),
  });

  await grantMediaPermissions(context, meetUrl);

  const page = await context.newPage();
  attachBrowserErrorHandlers(browser, context, page, correlationId);

  console.log(`${getCorrelationIdLog(correlationId)} Browser launched successfully!`);

  return { browser, context, page };
}

function attachBrowserErrorHandlers(
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

async function launchBrowserWithTimeout(
  launchFn: () => Promise<Browser>,
  timeoutMs: number,
  correlationId: string,
): Promise<Browser> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    launchFn()
      .then((result) => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          console.log(`${getCorrelationIdLog(correlationId)} Browser launch function success!`);
          resolve(result);
        }
      })
      .catch((error: unknown) => {
        console.error(`${getCorrelationIdLog(correlationId)} Error launching browser`, error);
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(error);
        }
      });
  });
}

async function resolveBrowserExecutablePath(correlationId: string): Promise<string> {
  const log = getCorrelationIdLog(correlationId);

  for (const candidate of FALLBACK_BROWSER_EXECUTABLE_PATHS) {
    if (await isExecutableFile(candidate)) {
      if (candidate !== DEFAULT_BROWSER_EXECUTABLE_PATH) {
        console.log(`${log} Falling back to browser executable ${candidate}`);
      }
      return candidate;
    }
  }

  throw new Error(
    `No browser executable found. Checked: ${FALLBACK_BROWSER_EXECUTABLE_PATHS.join(', ')}`,
  );
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function preparePrejoinScreen(page: Page, botDisplayName: string): Promise<void> {
  await waitForNameInput(page);
  await dismissMediaPrompt(page);
  await dismissKnownDialogs(page);
  await fillDisplayName(page, botDisplayName);
  await turnOffMicAndCamera(page);
}

async function waitForNameInput(page: Page): Promise<void> {
  for (const selector of NAME_INPUT_SELECTORS) {
    const input = page.locator(selector).first();
    if (await becomesVisible(input, 10_000)) {
      return;
    }
  }

  throw new Error('Timed out waiting for the Google Meet name input.');
}

async function dismissMediaPrompt(page: Page): Promise<void> {
  const dialog = page.locator(MEDIA_PROMPT_DIALOG_SELECTOR).first();
  if (!(await becomesVisible(dialog, 3_000))) {
    return;
  }

  const continueButton = page.locator(CONTINUE_WITHOUT_MEDIA_SELECTOR).first();
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click().catch(() => undefined);
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  }
}

async function dismissKnownDialogs(page: Page): Promise<void> {
  for (const selector of DISMISS_SELECTORS) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await delay(500);
    }
  }
}

async function fillDisplayName(page: Page, botDisplayName: string): Promise<void> {
  for (const selector of NAME_INPUT_SELECTORS) {
    const input = page.locator(selector).first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(botDisplayName);
      await page.waitForTimeout(500);
      return;
    }
  }

  throw new Error('Could not find the Google Meet name input.');
}

async function turnOffMicAndCamera(page: Page): Promise<void> {
  await turnOffPrejoinControl(page, MIC_TOGGLE_SELECTOR);
  await delay(1_000);
  await turnOffPrejoinControl(page, CAMERA_TOGGLE_SELECTOR);
}

async function turnOffPrejoinControl(page: Page, selector: string): Promise<void> {
  const control = page.locator(selector).first();
  if (!(await control.isVisible().catch(() => false))) {
    return;
  }

  const ariaPressed = await control.getAttribute('aria-pressed').catch(() => null);
  const dataMuted = await control.getAttribute('data-is-muted').catch(() => null);
  const shouldClick = ariaPressed === 'true' || dataMuted === 'false' || dataMuted === null;

  if (shouldClick) {
    await control.click().catch(() => undefined);
  }
}

async function clickJoinButton(page: Page, joinTimeoutMs: number): Promise<void> {
  for (const selector of JOIN_BUTTON_SELECTORS) {
    const button = page.locator(selector).first();
    if (await becomesVisible(button, 10_000)) {
      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForFunction(
        (joinSelector) => {
          const element = document.querySelector(joinSelector);
          if (!(element instanceof HTMLElement)) {
            return false;
          }

          const ariaDisabled = element.getAttribute('aria-disabled');
          const disabled = element.hasAttribute('disabled');
          return !disabled && ariaDisabled !== 'true';
        },
        selector,
        { timeout: joinTimeoutMs },
      ).catch(() => undefined);

      if (await clickJoinButtonSafely(page, selector, joinTimeoutMs)) {
        return;
      }

      throw new Error(`Found the Google Meet join control but could not click it using selector: ${selector}`);
    }
  }

  throw new Error('Could not find the Google Meet join control.');
}

async function clickJoinButtonSafely(page: Page, selector: string, joinTimeoutMs: number): Promise<boolean> {
  const button = page.locator(selector).first();

  try {
    await button.click({ timeout: joinTimeoutMs });
    return true;
  } catch {
    // Fall through to stronger click paths.
  }

  try {
    await button.click({ timeout: joinTimeoutMs, force: true });
    return true;
  } catch {
    // Fall through to DOM click.
  }

  try {
    const clicked = await page.evaluate((joinSelector) => {
      const element = document.querySelector(joinSelector);
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      element.click();
      return true;
    }, selector);

    return clicked;
  } catch {
    return false;
  }
}

async function waitForJoinSuccess(page: Page, joinTimeoutMs: number): Promise<void> {
  const deadline = Date.now() + joinTimeoutMs;

  while (Date.now() < deadline) {
    for (const selector of IN_MEETING_SELECTORS) {
      const button = page.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        return;
      }
    }

    const pageText = await page.locator('body').innerText().catch(() => '');
    if (/you can't join this call|ask to join was denied|meeting code not found/i.test(pageText)) {
      throw new Error(pageText.trim());
    }

    await delay(1_000);
  }

  throw new Error('Timed out waiting for the bot to join the meeting.');
}

async function safeLeaveMeeting(page: Page): Promise<void> {
  for (const selector of IN_MEETING_SELECTORS) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      return;
    }
  }
}

async function becomesVisible(locator: ReturnType<Page['locator']>, timeout: number): Promise<boolean> {
  try {
    await expect(locator).toBeVisible({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function createDebugScreenshotDir(sessionId: string, headless: boolean): Promise<string | undefined> {
  const timestamp = createTimestamp();
  const mode = headless ? 'headless' : 'headed';
  const directory = path.join(resolveArtifactRoot(DEFAULT_DEBUG_SCREENSHOT_ROOT), `${timestamp}-${mode}-${sessionId}`);

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

async function saveDebugScreenshot(
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
  await page.screenshot({
    path: filePath,
    fullPage: true,
    animations: 'disabled',
  }).catch((error: unknown) => {
    console.log(`[debug-screenshot] png capture failed label=${label} path=${filePath}: ${formatError(error)}`);
    return undefined;
  });

  console.log(`[debug-screenshot] finished label=${label} png=${filePath} html=${htmlPath} text=${textPath}`);

  return filePath;
}

function createTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveArtifactRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.join(process.cwd(), root);
}

function getCorrelationIdLog(correlationId: string): string {
  return `[join-meet:${correlationId}]`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

async function grantMediaPermissions(
  context: Awaited<ReturnType<Browser['newContext']>>,
  meetUrl: string,
): Promise<void> {
  try {
    await context.grantPermissions(['camera', 'microphone'], {
      origin: new URL(meetUrl).origin,
    });
  } catch {
    // Ignore permission grant failures and continue with browser defaults.
  }
}
