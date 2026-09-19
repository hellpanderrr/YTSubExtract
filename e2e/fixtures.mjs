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
  // Playwright injects `--disable-extensions` into every persistent-context
  // launch; user args cannot override a default (Chromium keeps the FIRST
  // occurrence), so it must be removed here or no extension ever loads. Seen
  // on chrome://version's Command Line: `--disable-extensions` sat before our
  // `--load-extension`, and zero service workers appeared.
  //
  // Playwright also injects `--use-mock-keychain` + `--password-store=basic`,
  // which make Chromium encrypt cookies with a throwaway mock key instead of
  // real DPAPI. A golden profile seeded by logging in with those flags keeps
  // working (same mock key every launch), but cookies copied in from a real
  // Chrome can never decrypt that way — and since Chrome 127 app-bound
  // encryption ties the key to the original user-data dir, cross-profile
  // cookie transfer is dead regardless (see docs/LESSONS.md). The supported
  // path is: log in ONCE via `npm run e2e:login` (same flags), then reuse.
  ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'],
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
 * Copy a Chrome profile directory, skipping lock and transient files: copying
 * a `SingletonLock`, SQLite `-journal`/`-wal`, caches, or `Crashpad/` produces
 * a subtly corrupt copy, and a copied lock makes the next launch refuse to
 * start.
 *
 */
function copyProfileFiltered(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const name = path.basename(p);
      if (name.startsWith('Singleton')) return false;
      if (name === 'LOCK' || name.startsWith('LOCK.')) return false;
      if (name.endsWith('-journal') || name.endsWith('-wal') || name.endsWith('-shm')) return false;
      if (name === 'Crashpad' || name === 'Cache' || name === 'Code Cache'
        || name === 'GPUCache' || name === 'Service Worker') return false;
      if (name.endsWith('.log')) return false;
      return true;
    },
  });
}

/**
 * Replace the working profile with a fresh copy of the golden one.
 *
 * Skips lock and transient files: copying a `SingletonLock`, SQLite `-journal`/
 * `-wal`, or `Crashpad/` from a profile Chromium has touched produces a subtly
 * corrupt copy, and a copied lock file makes the next launch refuse to start.
 */
async function prepareProfile() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  if (!fs.existsSync(GOLDEN_PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.warn(
      `[e2e] no golden profile at ${GOLDEN_PROFILE_DIR} — running signed out ` +
      `(login-gated specs will skip). Run \`npm run e2e:login\` once.`
    );
    return;
  }
  copyProfileFiltered(GOLDEN_PROFILE_DIR, PROFILE_DIR);

  // Seeded login cookies are DPAPI-encrypted; if the test browser cannot
  // decrypt them it silently drops every encrypted row on first read (the
  // working Cookies shrinks ~393KB → ~20KB), and the failure surfaces much
  // later as "playlist does not exist". So when the golden profile carries a
  // login, verify up front that the cookies survive a real Chromium launch.
  // A golden without auth cookies is the supported signed-out state
  // (login-gated specs skip) and needs no check.
  await verifyCookiesSurvived();
}

/**
 * Whether the golden Cookies DB holds a live (table-leaf, not freelist-stale)
 * YouTube auth row. Minimal SQLite reader: walks table-leaf pages, parses
 * record headers, and checks the host_key/name fields. ~40 lines, no deps.
 */
function goldenHasLiveAuthCookie() {
  const AUTH = new Set(['SID', 'SAPISID', 'LOGIN_INFO', '__Secure-1PSID', '__Secure-3PSID']);
  let sql;
  try {
    sql = fs.readFileSync(path.join(GOLDEN_PROFILE_DIR, 'Default', 'Network', 'Cookies'));
  } catch {
    return false;
  }
  if (sql.length < 100 || sql.subarray(0, 16).toString() !== 'SQLite format 3\0') return false;
  const pageSize = new DataView(sql.buffer, sql.byteOffset + 16, 2).getUint16(0) || 4096;
  const nPages = new DataView(sql.buffer, sql.byteOffset + 28, 4).getUint32(0);
  const varint = (buf, p) => {
    let v = 0, b;
    do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return [v, p];
  };
  for (let pg = 1; pg <= Math.min(nPages, sql.length / pageSize); pg++) {
    const off = (pg - 1) * pageSize;
    if (sql[off] !== 0x0d) continue; // table leaf only
    const dv = new DataView(sql.buffer, sql.byteOffset + off, pageSize);
    const n = dv.getUint16(3);
    for (let i = 0; i < n; i++) {
      const ptr = dv.getUint16(8 + i * 2);
      if (ptr + 2 > pageSize) continue;
      // Cell: varint payload-len, varint rowid, then the record. The record
      // starts with its header (serial types), then field values in schema
      // order: creation_utc, host_key, top_frame_site_key, name, ... — so
      // host_key and name sit at the head of the value area, in order.
      let p = off + ptr;
      let plen;
      [plen, p] = varint(sql, p);
      [, p] = varint(sql, p); // rowid
      const end = p + plen;
      if (end > sql.length) continue;
      [, p] = varint(sql, p); // header length
      const head = sql.subarray(p, Math.min(end, p + 160)).toString('binary');
      const hi = head.indexOf('.youtube.com');
      if (hi === -1) continue;
      const tail = head.slice(hi + 13, hi + 60);
      for (const name of AUTH) {
        if (tail.startsWith(name)) return true;
      }
    }
  }
  return false;
}

/**
 * Launch a throwaway Chromium against the working profile copy and check that
 * the seeded login cookies are still readable. Exits the process with a clear
 * message if Chromium dropped them (see prepareProfile).
 */
async function verifyCookiesSurvived() {
  // Only meaningful when the golden profile carries a login. A golden without
  // auth cookies is the supported signed-out state (login-gated specs skip).
  // NOTE: the Cookies file is SQLite, not text — read it as a buffer and
  // search the raw bytes. (An earlier version read it as utf8 and always saw
  // "no login", silently disabling this guard.) Stale bytes can linger in
  // freelist pages after Chromium deletes rows, so require the marker to
  // appear as a LIVE table-leaf row, not just anywhere in the file.
  if (!goldenHasLiveAuthCookie()) return;

  const probeDir = `${PROFILE_DIR}-cookieprobe`;
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.cpSync(PROFILE_DIR, probeDir, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(probeDir, {
      channel: 'chromium',
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const cookies = await context.cookies('https://www.youtube.com');
    const names = new Set(cookies.map((c) => c.name));
    const missing = ['SID', 'SAPISID', '__Secure-1PSID'].filter((n) => !names.has(n));
    if (missing.length > 0) {
      console.error(
        `[e2e] LOGIN LOST: Chromium dropped the golden profile's encrypted cookies ` +
        `(${missing.join(', ')} missing). The suite would run signed out. See docs/LESSONS.md.`
      );
      process.exit(2);
    }
    console.log('[e2e] login cookies survived the Chromium launch check.');
  } finally {
    if (context) await context.close().catch(() => {});
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
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
    await prepareProfile();

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
