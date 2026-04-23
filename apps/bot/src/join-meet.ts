import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { chromium } from 'playwright-extra';
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { JoinMeetRequest, JoinMeetResult } from '@meetingbot/shared';
import { injectRecorderScript } from './injector';
import {
  attachBrowserErrorHandlers,
  createDebugScreenshotDir,
  DEFAULT_DEBUG_VIDEO_ROOT,
  getCorrelationIdLog,
  resolveArtifactRoot,
  saveDebugScreenshot,
} from './join-meet-debug';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

const DEFAULT_JOIN_TIMEOUT_MS = 60000;
const DEFAULT_BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH ?? '/usr/bin/google-chrome';
const DEFAULT_HEADLESS = process.env.HEADLESS !== 'false';
const DEFAULT_TRANSCRIPTION_WS_URL = process.env.TRANSCRIPTION_WS_URL ?? 'ws://transcription:6666/ws';
const DEFAULT_RECORDER_CHUNK_MS = Number(process.env.RECORDER_CHUNK_MS ?? '1000');
const DEFAULT_RECORDER_MIME_TYPE = process.env.RECORDER_MIME_TYPE ?? 'audio/webm';
const DEFAULT_TRANSCRIPTION_LANGUAGE = process.env.TRANSCRIPTION_LANGUAGE;
const DEFAULT_TRANSCRIPTION_PROMPT = process.env.TRANSCRIPTION_PROMPT;
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

//not reliable
const MIC_TOGGLE_SELECTOR = 'div[jscontroller="t2mBxb"][data-anchor-id="hw0c9"]';
const CAMERA_TOGGLE_SELECTOR = 'div[jscontroller="bwqwSd"][data-anchor-id="psRWwc"]';

export const googleCameraButtonSelectors: string[] = [
  '[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn off camera"]',
  'button[aria-label*="Turn on camera"]'
];

export const googleMicrophoneButtonSelectors: string[] = [
  '[aria-label*="Turn off microphone"]',
  'button[aria-label*="Turn off microphone"]',
  'button[aria-label*="Turn on microphone"]'
];

const JOIN_BUTTON_SELECTORS = [
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'button:has-text("Join")'
];
const IN_MEETING_SELECTORS = [
  'button[aria-label*="Leave call"]',
  'button[aria-label*="Hang up"]',
  'button[data-tooltip-id*="hangup"]',
];

type JoinMeetHooks = {
  onRecordingStarted?: (details: { sessionId: string; joinedAt: string }) => Promise<void> | void;
};

export async function joinMeet(
  request: JoinMeetRequest,
  hooks: JoinMeetHooks = {},
): Promise<JoinMeetResult> {
  const sessionId = request.sessionId ?? randomUUID();
  const joinTimeoutMs = request.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
  const headless = request.headless ?? DEFAULT_HEADLESS;

  let browser: Browser | undefined;
  let page: Page | undefined;
  let screenshotDir: string | undefined;

  try {
    ({ browser, page } = await createBrowserContext(request.meetUrl, sessionId, headless));

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
    await injectRecorderScript(page, {
      wsUrl: resolveRecorderWebSocketUrl(sessionId),
      sessionId,
      chunkMs: DEFAULT_RECORDER_CHUNK_MS,
      mimeType: DEFAULT_RECORDER_MIME_TYPE,
      language: DEFAULT_TRANSCRIPTION_LANGUAGE,
      prompt: DEFAULT_TRANSCRIPTION_PROMPT,
    });

    const joinedAt = new Date().toISOString();
    await hooks.onRecordingStarted?.({ sessionId, joinedAt });
    scheduleAutoLeave(browser, request.stayInMeetingMs);

    await waitForBrowserClosed(browser);

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
    if (browser?.isConnected()) {
      await browser.close();
    }
  }
}

function resolveRecorderWebSocketUrl(sessionId: string): string {
  const url = new URL(DEFAULT_TRANSCRIPTION_WS_URL);
  url.searchParams.set('sessionId', sessionId);

  if (DEFAULT_TRANSCRIPTION_LANGUAGE) {
    url.searchParams.set('language', DEFAULT_TRANSCRIPTION_LANGUAGE);
  }

  if (DEFAULT_TRANSCRIPTION_PROMPT) {
    url.searchParams.set('prompt', DEFAULT_TRANSCRIPTION_PROMPT);
  }

  if (DEFAULT_RECORDER_MIME_TYPE) {
    url.searchParams.set('mimeType', DEFAULT_RECORDER_MIME_TYPE);
  }

  return url.toString();
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
    '--use-fake-ui-for-media-stream', // Bypass permission prompt
    '--use-fake-device-for-media-stream' // Use fake camera/mic
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
  await turnOffPrejoinControl(page, googleMicrophoneButtonSelectors[0]);
  await delay(1_000);
  await turnOffPrejoinControl(page, googleCameraButtonSelectors[0]);
}

async function turnOffPrejoinControl(page: Page, selector: string): Promise<void> {
  try{
    await page.click(selector, {timeout: 3000})
  }catch(e){
    console
  }
}

async function getJoinButton(
  page: Page,
  joinButtonSelectors: string[],
  timeoutMs: number,
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  try {
    const joinBtn = await Promise.race(
      joinButtonSelectors.map((selector) => page.waitForSelector(selector, { timeout: timeoutMs })),
    );
    console.log('Join button found');
    return joinBtn;
  } catch (e) {
    console.log('Page could not find Join button');
    return null;
  }
}

async function clickJoinButton(page: Page, joinTimeoutMs: number): Promise<void> {
  const joinBtn = await getJoinButton(page, JOIN_BUTTON_SELECTORS, joinTimeoutMs);
  if (!joinBtn) {
    throw new Error('Could not find the Google Meet join control.');
  }

  await joinBtn.scrollIntoViewIfNeeded().catch(() => undefined);

  await page
    .waitForFunction(
      (el) => {
        if (!(el instanceof HTMLElement)) {
          return false;
        }
        const ariaDisabled = el.getAttribute('aria-disabled');
        const disabled = el.hasAttribute('disabled');
        return !disabled && ariaDisabled !== 'true';
      },
      joinBtn,
      { timeout: joinTimeoutMs },
    )
    .catch(() => undefined);

  try {
    await joinBtn.click({ timeout: joinTimeoutMs });
    return;
  } catch {
    // Fall through to stronger click paths.
  }

  try {
    await joinBtn.click({ timeout: joinTimeoutMs, force: true });
    return;
  } catch {
    // Fall through to DOM click.
  }

  const clicked = await joinBtn.evaluate((el) => {
    if (el instanceof HTMLElement) {
      el.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    throw new Error('Found the Google Meet join control but could not click it.');
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

function waitForBrowserClosed(browser: Browser): Promise<void> {
  return new Promise((resolve) => {
    if (!browser.isConnected()) {
      resolve();
      return;
    }
    browser.once('disconnected', () => {
      resolve();
    });
  });
}

function scheduleAutoLeave(browser: Browser, stayInMeetingMs: number | undefined): void {
  if (typeof stayInMeetingMs !== 'number' || stayInMeetingMs <= 0) {
    return;
  }

  setTimeout(() => {
    if (browser.isConnected()) {
      browser.close().catch(() => undefined);
    }
  }, stayInMeetingMs);
}

async function becomesVisible(locator: ReturnType<Page['locator']>, timeout: number): Promise<boolean> {
  try {
    await expect(locator).toBeVisible({ timeout });
    return true;
  } catch {
    return false;
  }
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
