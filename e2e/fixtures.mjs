/**
 * Playwright fixtures for the YTSubExtract extension e2e suite.
 *
 * Key constraints handled here:
 *  - MV3 extensions require a *persistent* context (launchPersistentContext).
 *  - Extensions do NOT work in the headless shell; we must use full chromium
 *    via `channel: 'chromium'` to run headless with extensions.
 *  - The extension ID is only discoverable from the background service worker URL.
 *  - Downloads triggered by a page surface as Playwright `download` events and
 *    are persisted via `download.saveAs()`. Downloads triggered by the service
 *    worker (chrome.downloads.download) do NOT, and must be located through the
 *    extension's own chrome.downloads API (see helpers.waitForZipDownload).
 *
 * The context is worker-scoped: it launches once and is reused across tests.
 * Relaunching per test on the same profile dir causes intermittent Chromium
 * crashes, so the browser is only started at worker start and closed at its end.
 *
 * The browser profile lives in .e2e-profile/ and is reused across runs, which is
 * what keeps the one-time manual YouTube login alive for headless runs.
 */
import { test as base, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const EXTENSION_DIR = path.resolve(ROOT, 'dist');
export const PROFILE_DIR = path.resolve(ROOT, '.e2e-profile');
export const DOWNLOAD_DIR = path.resolve(ROOT, '.e2e-downloads');

/**
 * Worker-scoped browser + extension id.
 *
 * Launching the persistent context once per worker (rather than once per test)
 * avoids profile contention and the intermittent Chromium STATUS_BREAKPOINT
 * crashes that come from repeatedly opening the same profile directory.
 */
const worker = base.extend({
  _browser: [async ({}, use) => {
    if (!fs.existsSync(EXTENSION_DIR)) {
      throw new Error(
        `Extension build not found at ${EXTENSION_DIR}.\n` +
        `Run \`npm run build\` before running e2e tests.`
      );
    }
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    const launchOptions = {
      // Full chromium (not headless shell) — required for extensions.
      channel: 'chromium',
      // Cold-start of a persistent profile is slow on Windows; the default is
      // too tight when the machine is busy.
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

    // Chromium intermittently exits with STATUS_BREAKPOINT (0x80000003) on cold
    // start under memory pressure. Retry so a transient failure doesn't fail
    // the whole worker.
    let context;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[e2e] launch attempt ${attempt}/3 failed: ${err.message.split('\n')[0]}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!context) throw lastError;

    await use(context);
    await context.close();
  }, { scope: 'worker' }],

  extensionId: [async ({ _browser }, use) => {
    let [sw] = _browser.serviceWorkers();
    if (!sw) {
      sw = await _browser.waitForEvent('serviceworker', { timeout: 20_000 });
    }
    await use(new URL(sw.url()).host);
  }, { scope: 'worker' }],
});

export const test = worker.extend({
  // Expose the worker-scoped browser under the familiar `context` name.
  context: async ({ _browser }, use) => use(_browser),

  // Auto-cleanup: close every page a test opened, so tests stay isolated
  // despite sharing one worker-scoped browser.
  _cleanup: [async ({ _browser }, use) => {
    const before = new Set(_browser.pages());
    await use(null);
    for (const page of _browser.pages()) {
      if (!before.has(page)) await page.close().catch(() => {});
    }
  }, { auto: true }],
});

export const expect = test.expect;
