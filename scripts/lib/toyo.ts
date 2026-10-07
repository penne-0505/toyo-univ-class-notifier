import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadProjectEnv } from './toyo-env';

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultChromePath = '/opt/google/chrome/chrome';
const loginHost = 'slink.secioss.com';
export const ssoRecoveryLoginUrl =
  'https://slink.secioss.com/pub/login.cgi?back=%2fuser%2findex.php%3ftenant%3dtoyo.jp';

loadProjectEnv();

export const portalUrl = process.env.TOYO_PORTAL_URL || 'https://g-sys.toyo.ac.jp/portal';

export interface Paths {
  repoRoot: string;
  artifactDir: string;
  authDir: string;
  profileDir: string;
  storageStatePath: string;
}

export interface BrowserLaunchOptions {
  headless: boolean;
}

export interface SessionMetadata {
  savedAt: string;
  title: string;
  url: string;
}

export interface PortalLinkSummary {
  text: string;
  href: string | null;
}

export interface PortalSummary {
  title: string;
  url: string;
  headings: string[];
  links: PortalLinkSummary[];
  textPreview: string;
}

export interface SnapshotArtifact {
  screenshotPath: string;
  summaryPath: string;
  summary: PortalSummary;
}

export interface StateContext {
  browser: Browser;
  context: BrowserContext;
}

export type ToyoSessionLossReason =
  | 'sso-login'
  | 'login-form'
  | 'mfa-settings'
  | 'system-error'
  | 'timeout';

export interface ToyoSessionRecoveryOptions {
  returnUrl?: string;
  saveState?: boolean;
  snapshotTag?: string;
  timeoutMs?: number;
}

export interface ToyoSessionRecoveryResult {
  finalUrl: string;
  loginUrl: string;
  reason: ToyoSessionLossReason | null;
  recovered: boolean;
  returnUrl: string;
}

export const paths: Paths = {
  repoRoot,
  artifactDir: process.env.TOYO_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', 'toyo'),
  authDir: process.env.TOYO_AUTH_DIR || path.join(repoRoot, 'playwright', '.auth'),
  profileDir:
    process.env.TOYO_PROFILE_DIR || path.join(repoRoot, 'playwright', '.profiles', 'toyo'),
  storageStatePath:
    process.env.TOYO_STORAGE_STATE ||
    path.join(repoRoot, 'playwright', '.auth', 'toyo-state.json'),
};

export function getChromePath(): string {
  return process.env.TOYO_CHROME_PATH || process.env.CHROME_PATH || defaultChromePath;
}

export function shouldRunHeadless(defaultValue: boolean): boolean {
  if (process.env.TOYO_HEADLESS === '1') return true;
  if (process.env.TOYO_HEADLESS === '0') return false;
  return defaultValue;
}

async function ensureRuntimeDirs(): Promise<void> {
  await Promise.all([
    fsp.mkdir(paths.artifactDir, { recursive: true }),
    fsp.mkdir(paths.authDir, { recursive: true }),
    fsp.mkdir(path.dirname(paths.storageStatePath), { recursive: true }),
    fsp.mkdir(path.dirname(paths.profileDir), { recursive: true }),
  ]);
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function isLoginUrl(urlString: string): boolean {
  try {
    return new URL(urlString).hostname === loginHost;
  } catch {
    return false;
  }
}

export function isPortalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.hostname === 'g-sys.toyo.ac.jp' && url.pathname.startsWith('/portal');
  } catch {
    return false;
  }
}

export async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages().find((page) => !page.isClosed());
  return existing || context.newPage();
}

export async function launchPersistentBrowser({
  headless,
}: BrowserLaunchOptions): Promise<BrowserContext> {
  await ensureRuntimeDirs();
  return chromium.launchPersistentContext(paths.profileDir, {
    executablePath: getChromePath(),
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export async function launchBrowser({ headless }: BrowserLaunchOptions): Promise<Browser> {
  await ensureRuntimeDirs();
  return chromium.launch({
    executablePath: getChromePath(),
    headless,
  });
}

export async function launchStateContext({
  headless,
}: BrowserLaunchOptions): Promise<StateContext> {
  await ensureRuntimeDirs();
  if (!(await fileExists(paths.storageStatePath))) {
    throw new Error(
      `Saved auth state was not found at ${paths.storageStatePath}. Run "npm run toyo:login" first.`
    );
  }

  const browser = await launchBrowser({ headless });
  const context = await browser.newContext({
    storageState: paths.storageStatePath,
    viewport: { width: 1440, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });

  return { browser, context };
}

export async function gotoPortal(page: Page): Promise<void> {
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

export async function autoFillLogin(page: Page): Promise<boolean> {
  const username = process.env.TOYO_USERNAME;
  const password = process.env.TOYO_PASSWORD;
  if (!username || !password) {
    return false;
  }

  const hasUsername = (await page.locator('#username_input').count()) > 0;
  const hasPassword = (await page.locator('#password_input').count()) > 0;
  if (!hasUsername || !hasPassword) {
    return false;
  }

  await page.locator('#username_input').fill(username);
  await page.locator('#password_input').fill(password);
  await page.locator('#login_button').click();
  return true;
}

export async function detectToyoSessionLoss(
  page: Page
): Promise<ToyoSessionLossReason | null> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const hasLoginForm =
    (await page.locator('#username_input, #password_input, #login_button').count()) > 0;
  const bodyText = await page
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch(() => '');

  if (title.includes('システムエラー') || bodyText.includes('システムエラー')) {
    return 'system-error';
  }
  if (bodyText.includes('タイムアウトしました')) {
    return 'timeout';
  }
  if (bodyText.includes('多要素認証設定画面')) {
    return 'mfa-settings';
  }
  if (hasLoginForm) {
    return 'login-form';
  }
  if (isLoginUrl(url)) {
    return 'sso-login';
  }

  return null;
}

export async function recoverToyoSessionIfNeeded(
  page: Page,
  options: ToyoSessionRecoveryOptions = {}
): Promise<ToyoSessionRecoveryResult> {
  const reason = await detectToyoSessionLoss(page);
  const returnUrl = options.returnUrl ?? page.url();
  const timeoutMs = options.timeoutMs ?? 60_000;

  if (!reason) {
    return {
      finalUrl: page.url(),
      loginUrl: ssoRecoveryLoginUrl,
      reason,
      recovered: false,
      returnUrl,
    };
  }

  if (options.snapshotTag) {
    await collectPortalSnapshot(page, options.snapshotTag).catch(() => {});
  }

  await page.goto(ssoRecoveryLoginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  const autoSubmitted = await autoFillLogin(page);
  if (!autoSubmitted) {
    const recoveryPageReason = await detectToyoSessionLoss(page);
    if (recoveryPageReason === 'login-form' || recoveryPageReason === 'sso-login') {
      throw new Error(
        `Toyo SSO recovery was required (${reason}), but credentials could not be autofilled. Run "npm run toyo:login" manually.`
      );
    }
  } else {
    await page
      .waitForFunction(
        () =>
          window.location.hostname !== 'slink.secioss.com' ||
          document.querySelector('#username_input, #password_input, #login_button') === null,
        undefined,
        { timeout: timeoutMs }
      )
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  if (returnUrl && !isPortalUrl(returnUrl)) {
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const portalReason = await detectToyoSessionLoss(page);
    if (portalReason && portalReason !== 'mfa-settings') {
      throw new Error(
        `Toyo SSO recovery reached the portal warm-up step, but the session still appears invalid (${portalReason}). Current URL: ${page.url()}`
      );
    }
  }

  if (returnUrl && page.url() !== returnUrl) {
    await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  const remainingReason = await detectToyoSessionLoss(page);
  if (remainingReason) {
    throw new Error(
      `Toyo SSO recovery finished, but the session still appears invalid (${remainingReason}). Current URL: ${page.url()}`
    );
  }

  if (options.saveState) {
    await saveSessionState(page.context(), page);
  }

  return {
    finalUrl: page.url(),
    loginUrl: ssoRecoveryLoginUrl,
    reason,
    recovered: true,
    returnUrl,
  };
}

export async function waitForSession(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    ({ portal, login }: { portal: string; login: string }) => {
      const current = window.location.href;
      try {
        const url = new URL(current);
        return (
          (url.hostname === 'g-sys.toyo.ac.jp' && url.pathname.startsWith('/portal')) ||
          (!current.includes(login) && current.startsWith(portal))
        );
      } catch {
        return false;
      }
    },
    { portal: portalUrl, login: loginHost },
    { timeout: timeoutMs }
  );
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

export async function saveSessionState(context: BrowserContext, page: Page): Promise<void> {
  await ensureRuntimeDirs();
  await context.storageState({ path: paths.storageStatePath });
  const metadata: SessionMetadata = {
    savedAt: new Date().toISOString(),
    title: await page.title(),
    url: page.url(),
  };
  await fsp.writeFile(
    path.join(paths.authDir, 'toyo-session.json'),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );
}

export async function collectPortalSnapshot(
  page: Page,
  tag: string
): Promise<SnapshotArtifact> {
  await ensureRuntimeDirs();
  const safeTag = tag.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const screenshotPath = path.join(paths.artifactDir, `${safeTag}.png`);
  const summaryPath = path.join(paths.artifactDir, `${safeTag}.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const summary = await page.evaluate((): PortalSummary => {
    const text = document.body.innerText.replace(/\s+/g, ' ').trim();
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .map((el) => el.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, 20);
    const links = [...document.querySelectorAll('a')]
      .map((el) => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        href: el.href || null,
      }))
      .filter((item) => item.text || item.href)
      .slice(0, 30);

    return {
      title: document.title,
      url: window.location.href,
      headings,
      links,
      textPreview: text.slice(0, 3000),
    };
  });

  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  return { screenshotPath, summaryPath, summary };
}

export async function readSessionMetadata(): Promise<SessionMetadata | null> {
  const metadataPath = path.join(paths.authDir, 'toyo-session.json');
  if (!(await fileExists(metadataPath))) {
    return null;
  }

  const raw = await fsp.readFile(metadataPath, 'utf8');
  return JSON.parse(raw) as SessionMetadata;
}
