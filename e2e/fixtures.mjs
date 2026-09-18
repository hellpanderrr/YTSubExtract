/**
 * Playwright fixtures for the YTSubExtract extension e2e suite.
 *
 * Key constraints handled here:
 *  - MV3 extensions require a *persistent* context (launchPersistentContext).
 *  - Extensions do NOT work in the headless shell; we must use full chromium
 *    via `channel: 'chromium'` to run headless with extensions.
 *  - The browser is not usable the instant launchPersistentContext returns:
 *    Chromium is still initializing extensions, so anything touching pages or
 *    the service worker races (see `waitForBrowserReady`).
 *  - Headless Chromium with an extension intermittently dies with a NATIVE
 *    crash on Windows (0xC0000005 ACCESS_VIOLATION, 0x80000003
 *    STATUS_BREAKPOINT). This is a browser-process fault, not a test failure,
 *    and cannot be fixed from a Playwright fixture. See docs/LESSONS.md.
 *  - Downloads triggered from a page surface as Playwright `download` events;
 *    downloads triggered from the service worker (chrome.downloads.download) do
 *    NOT, and are located via the extension's own chrome.downloads API (see
 *    helpers.waitForZipDownload).
 *
 * Two design choices follow directly from the facts above (see docs/LESSONS.md):
 *
 *  1. The browser is launched TEST-scoped, once per test. Measured on this
 *     machine, launches issued from inside a running test were stable, while
 *     launches from worker-fixture setup crashed often. A test-scoped launch
 *     also makes `retries` work: Playwright does not recreate worker-scoped
 *     fixtures on retry, so a worker-scoped browser would stay dead.
 *
 *  2. Each run works on a FRESH COPY of a golden profile (`.e2e-profile-golden`,
 *     created by `npm run e2e:login`). Reusing one profile in place made a warm
 *     profile fail where a fresh one passed — the one reliably reproducible
 *     finding in this harness. Copying keeps that fresh-profile case *and*
 *     preserves the login (which live re-login cannot do headlessly).
 */
import { test as base, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const EXTENSION_DIR = path.resolve(ROOT, 'dist');
/** Signed-in profile created by `npm run e2e:login`. Never mutated by tests. */
export const GOLDEN_PROFILE_DIR = path.resolve(ROOT, '.e2e-profile-golden');
/** Throwaway working copy each run starts from. */
export const PROFILE_DIR = path.resolve(ROOT, '.e2e-profile');
export const DOWNLOAD_DIR = path.resolve(ROOT, '.e2e-downloads');

const LAUNCH_OPTIONS = {
  // Full chromium (not headless shell) — required for extensions.
  channel: 'chromium',
  // Cold start of a persistent profile is slow on Windows; the default is too
  // tight when the machine is busy.
  timeout: 120_000,
  // Honours `playwright test --headed` (the CLI flag lands in argv) plus an
  // explicit E2E_HEADED=1 override.
  headless: !(process.argv.includes('--headed') || process.env.E2E_HEADED === '1'),
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
  ],
};

/**
 * Wait until the launched browser is usable, and keep it alive.
 *
 * A persistent context exposes no `isConnected()`, so the only reliable
 * readiness signal is a successful `newPage()`. That page is KEPT OPEN: in a
 * persistent context Chromium exits when its last window closes.
 */
async function waitForBrowserReady(context, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    const probe = await context.newPage().catch((err) => {
      lastError = err;
      return null;
    });
    if (probe) {
      await probe.goto('about:blank').catch(() => {});
      return probe; // keepalive — never closed
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Browser never became usable within ${timeout}ms: ${lastError?.message}`);
}

/** Launch one persistent context, retrying the native startup crash. */
async function launchBrowser() {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let context;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH_OPTIONS);
      const keepalive = await waitForBrowserReady(context);
      // The crash can land a few ms after launch, so prove the browser is still
      // serving requests before accepting it.
      await new Promise((r) => setTimeout(r, 500));
      await keepalive.evaluate(() => 1);
      return context;
    } catch (err) {
      lastError = err;
      console.warn(`[e2e] launch attempt ${attempt}/4 failed: ${err.message.split('\n')[0]}`);
      if (context) await context.close().catch(() => {});
      if (attempt < 4) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

const COMPONENT_PDF_VIEWER = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
/** The extension ID for an unpacked build is path-derived, so it is stable. */
function extensionIdFromProfile() {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(PROFILE_DIR, 'Default', 'Secure Preferences'), 'utf8')
    );
    return (
      Object.keys(data?.extensions?.settings || {}).find(
        (k) => /^[a-p]{32}$/.test(k) && k !== COMPONENT_PDF_VIEWER
      ) || null
    );
  } catch {
    return null;
  }
}

/**
 * Replace the working profile with a fresh copy of the golden one.
 *
 * Skips lock and transient files: copying a `SingletonLock`, SQLite `-journal`/
 * `-wal`, or `Crashpad/` from a profile Chromium has touched produces a subtly
 * corrupt copy, and a copied lock file makes the next launch refuse to start.
 */
function prepareProfile() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  if (!fs.existsSync(GOLDEN_PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.warn(
      `[e2e] no golden profile at ${GOLDEN_PROFILE_DIR} — running signed out ` +
      `(login-gated specs will skip). Run \`npm run e2e:login\` once.`
    );
    return;
  }
  fs.cpSync(GOLDEN_PROFILE_DIR, PROFILE_DIR, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (name === 'SingletonLock' || name === 'SingletonSocket' || name === 'SingletonCookie') {
        return false;
      }
      if (name === 'LOCK' || name.startsWith('LOCK.')) return false;
      if (name.endsWith('-journal') || name.endsWith('-wal') || name.endsWith('-shm')) return false;
      if (name === 'Crashpad') return false;
      if (name.endsWith('.log')) return false;
      return true;
    },
  });
}

const worker = base.extend({
  /**
   * Prepare a fresh working profile once per worker, then launch ONE browser.
   *
   * The browser is worker-scoped deliberately. `context.close()` does not
   * synchronously release the profile's `SingletonLock` / SQLite handles on
   * Windows, so launching a persistent context per test reliably lands the next
   * launch on a half-released profile. One browser per worker avoids that.
   *
   * The profile is a copy of the golden one so every run starts from the same
   * known-good, signed-in state (headless re-login is not possible).
   */
  // Named `_browser`, not `context`: `context` is a builtin fixture name and
  // overriding it with a worker-scoped one is rejected by Playwright.
  _browser: [async ({}, use) => {
    if (!fs.existsSync(EXTENSION_DIR)) {
      throw new Error(
        `Extension build not found at ${EXTENSION_DIR}.\n` +
        `Run \`npm run build\` before running e2e tests.`
      );
    }
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    prepareProfile();

    const context = await launchBrowser();
    await use(context);
    await context.close().catch(() => {});
  }, { scope: 'worker' }],

  extensionId: [async ({ _browser }, use) => {
    const fromSw = () => {
      const [sw] = _browser.serviceWorkers();
      if (sw && sw.url().startsWith('chrome-extension://')) return new URL(sw.url()).host;
      return null;
    };
    let id = fromSw() || extensionIdFromProfile();
    const deadline = Date.now() + 20_000;
    while (!id && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      id = fromSw() || extensionIdFromProfile();
    }
    if (!id) {
      throw new Error(
        'Could not determine the extension ID. Is the extension built ' +
        '(npm run build) and loadable? See e2e/README.md.'
      );
    }
    await use(id);
  }, { scope: 'worker' }],
});

export const test = worker.extend({
  // Expose the worker-scoped browser under the familiar `context` name.
  context: async ({ _browser }, use) => use(_browser),

  // Auto-isolation: clear leftover download progress before each test.
  //
  // The extension persists `currentDownloadProgress` in chrome.storage.local and
  // restores it on popup open. A batch left running by a failed test would
  // otherwise disable the Download ZIP button and make the next test look like a
  // product regression (a stale `running` entry did exactly that).
  _resetProgress: [async ({ context }, use) => {
    const [sw] = context.serviceWorkers();
    if (sw) {
      await sw
        .evaluate(async () => {
          await chrome.storage.local.remove('currentDownloadProgress');
        })
        .catch(() => {});
    }
    await use(null);
  }, { auto: true }],

  // Close every page a test opened, so tests stay isolated despite sharing one
  // browser. The launch-time keepalive page is left open (closing the last
  // window would exit a persistent context).
  _cleanup: [async ({ context }, use) => {
    const before = new Set(context.pages());
    await use(null);
    for (const page of context.pages()) {
      if (!before.has(page)) await page.close().catch(() => {});
    }
  }, { auto: true }],
});

export const expect = test.expect;
