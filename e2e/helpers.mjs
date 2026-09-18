/**
 * Shared helpers for the extension e2e suite.
 */
import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';
import { DOWNLOAD_DIR, PROFILE_DIR } from './fixtures.mjs';

export { DOWNLOAD_DIR, PROFILE_DIR };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether the persistent profile appears to be signed into YouTube.
 * Checks for YouTube's HttpOnly auth cookies, which persist in the profile dir.
 */
export async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.youtube.com');
  const names = new Set(cookies.map((c) => c.name));
  // __Secure-1PSID / __Secure-3PSID / SAPISID / SID are set only when signed in.
  return ['__Secure-1PSID', 'SAPISID', 'SID', '__Secure-3PSID'].some((n) => names.has(n));
}

/**
 * Skip the current test unless the profile is signed into YouTube.
 * Uses Playwright's `test.skip()` so a missing prerequisite is a skip, not a
 * failure.
 */
export async function requireLogin(context, test) {
  if (await isLoggedIn(context)) return;
  test.skip(
    true,
    'Not signed into YouTube in the e2e profile — run `npm run e2e:login` once ' +
    `(profile: ${PROFILE_DIR}).`
  );
}

/**
 * Open the extension popup as a tab.
 *
 * The popup calls `chrome.tabs.query({ active: true, currentWindow: true })`.
 * When the popup is opened as a regular tab it becomes the active tab itself,
 * so the popup sees its own URL and reports "Not a YouTube video or playlist page".
 *
 * To make the popup observe the YouTube tab, we:
 *   1. bring the YouTube tab to the front,
 *   2. open the popup tab,
 *   3. bring the YouTube tab to the front again,
 *   4. reload the popup so its init() runs while YouTube is the active tab.
 */
export async function openPopup(context, extensionId, ytPage) {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 420, height: 700 });
  const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;

  await ytPage.bringToFront();
  await popup.goto(popupUrl, { waitUntil: 'domcontentloaded' });
  await ytPage.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });

  return popup;
}

/**
 * Wait until the popup has finished its initial async work (status text is no
 * longer "Initializing...").
 */
export async function waitForPopupReady(popup, timeout = 60_000) {
  await expect
    .poll(
      async () => popup.evaluate(() => document.getElementById('status')?.textContent || ''),
      { timeout, message: 'popup status never left "Initializing..."' }
    )
    .not.toContain('Initializing');
}

/**
 * Wait until the single-video controls are usable: the language dropdown is
 * populated and the format buttons are enabled. Live metadata fetches can take
 * a while, so this uses a generous default rather than the short expect timeout.
 */
export async function waitForSingleVideoReady(popup, timeout = 90_000) {
  await expect
    .poll(
      () => popup.evaluate(() => document.getElementById('lang-select')?.options.length || 0),
      { timeout, message: 'language dropdown never populated' }
    )
    .toBeGreaterThan(0);

  await expect
    .poll(() => popup.evaluate(() => document.getElementById('btn-srt')?.disabled), {
      timeout,
      message: 'SRT button never enabled',
    })
    .toBe(false);
}

/** Read a snapshot of popup UI state. */
export async function readPopupState(popup) {
  return popup.evaluate(() => ({
    status: document.getElementById('status')?.textContent || '',
    playlistMode: !document.getElementById('playlist-mode')?.classList.contains('hidden'),
    videoCount: document.querySelectorAll('.playlist-video-item').length,
    selectedCount: document.getElementById('selected-count')?.textContent || '',
    zipEnabled: !document.getElementById('btn-download-zip')?.disabled,
    progressText: document.getElementById('progress-text')?.textContent || '',
    logs: document.getElementById('logs')?.value || '',
  }));
}

/**
 * Wait until the popup has rendered at least `min` playlist video rows.
 *
 * Rows appear before init() finishes checkAndRestoreProgress(), which is what
 * enables the ZIP button, so callers that need the fully-settled UI should use
 * `waitForPlaylistReady` instead.
 */
export async function waitForPlaylistVideos(popup, min = 1, timeout = 120_000) {
  await expect
    .poll(
      async () => popup.evaluate(() => document.querySelectorAll('.playlist-video-item').length),
      { timeout, message: `playlist never rendered ${min}+ videos` }
    )
    .toBeGreaterThanOrEqual(min);
}

/**
 * Wait until the playlist UI is fully settled: rows rendered AND the ZIP button
 * has been re-enabled by checkAndRestoreProgress().
 */
export async function waitForPlaylistReady(popup, min = 1, timeout = 120_000) {
  await waitForPlaylistVideos(popup, min, timeout);
  await expect
    .poll(() => popup.evaluate(() => document.getElementById('btn-download-zip')?.disabled), {
      timeout,
      message: 'Download ZIP never became enabled (init may not have settled)',
    })
    .toBe(false);
}

/**
 * Poll the popup's progress until the batch download reports completed or error.
 * Returns { status, progressText, failed }.
 */
export async function waitForBatchComplete(popup, timeout = 900_000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const state = await readPopupState(popup);
    const line = `${state.progressText} :: ${state.status}`;
    if (line !== last) {
      console.log(`[e2e] ${line}`);
      last = line;
    }
    if (state.status.includes('Saved!') || state.status.toLowerCase().includes('complete')) {
      return state;
    }
    // Match the popup's actual error messages. Do NOT match a bare "failed" —
    // the in-progress status is "Downloading... N/M (K failed)" and would
    // false-positive.
    if (/^(Download failed|Failed to start download|Failed to load playlist)/.test(state.status)) {
      throw new Error(`Batch download failed: ${state.status}\n${state.logs}`);
    }
    await sleep(2000);
  }
  throw new Error(`Batch download timed out after ${timeout}ms (last: ${last})`);
}

/** Snapshot the list of files currently in the download dir. */
export function listDownloads() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs.readdirSync(DOWNLOAD_DIR);
}

/**
 * Wait for a download to complete on `page` and persist it to DOWNLOAD_DIR.
 *
 * Uses Playwright's native `download` event rather than polling the filesystem:
 * the extension triggers downloads via chrome.downloads.download and an anchor
 * click, both of which Playwright surfaces as `download` events.
 *
 * `predicate` receives the suggested filename; returns the saved file path.
 */
export async function waitForDownload(context, predicate, timeout = 300_000) {
  // Playwright's own `download` event is unreliable here: Chromium tears down
  // the extension popup page ~400ms after a download starts, so
  // `download.saveAs()` races with the page closing. Instead, ask the
  // extension's chrome.downloads API what it wrote — that survives popup
  // teardown and reports the real on-disk path.
  return waitForFileDownloaded(context, predicate, timeout);
}

/**
 * Poll the extension's chrome.downloads API until a completed download matching
 * `predicate` appears. Returns the on-disk path.
 *
 * Playwright hands extension downloads opaque UUID filenames in its own
 * artifacts directory, so the extension's declared filename is gone by the time
 * we can look. `predicate` therefore receives a *synthetic* name derived from
 * the file's content (see `classifyDownload`), e.g. "x.srt" / "x.zip".
 *
 * We must NOT set a CDP Browser.setDownloadBehavior download path here:
 * Chromium crashes the transfer ("Download interrupted: CRASH") when the
 * extension popup page is torn down mid-download under an explicit CDP path.
 */
export async function waitForFileDownloaded(context, predicate, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  const seen = [];

  while (Date.now() < deadline) {
    const sw = await getServiceWorker(context);
    if (sw) {
      let items = [];
      try {
        items = await sw.evaluate(async () => {
          const list = await chrome.downloads.search({ limit: 20, orderBy: ['-startTime'] });
          return list.map((d) => ({
            state: d.state,
            filename: d.filename,
            exists: d.exists,
            error: d.error,
          }));
        });
      } catch {
        // Service worker went idle mid-poll; retry on the next tick.
      }

      for (const item of items) {
        if (item.filename && !seen.includes(item.filename)) seen.push(item.filename);
        if (item.state === 'interrupted') {
          throw new Error(`Download interrupted: ${item.error} (${item.filename})`);
        }
        if (item.state === 'complete' && item.exists && fs.existsSync(item.filename)) {
          const kind = classifyDownload(item.filename);
          if (kind && predicate(kind)) return item.filename;
        }
      }
    }
    await sleep(500);
  }

  throw new Error(
    `No matching download within ${timeout}ms.\n` +
    `Files seen: ${seen.join(', ') || '(none)'}`
  );
}

/**
 * Identify a downloaded file by its content, returning a synthetic filename
 * ("x.srt", "x.vtt", "x.txt", "x.zip") or null if unrecognised.
 */
function classifyDownload(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  // ZIP magic bytes "PK"
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'x.zip';

  const head = buf.subarray(0, 1024).toString('utf8');
  if (head.startsWith('WEBVTT')) return 'x.vtt';
  // SRT: cue number, then an arrow timestamp line
  if (/^\s*1\s*\r?\n\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)) return 'x.srt';
  // Anything else that is valid text is treated as TXT.
  if (/^[\s\S]*[^ --]/.test(head)) return 'x.txt';

  return null;
}

/** Get the extension's service worker, waking it if it has gone idle. */
async function getServiceWorker(context) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  try {
    return await context.waitForEvent('serviceworker', { timeout: 5000 });
  } catch {
    return null;
  }
}

/** Clear the download dir between tests. */
export function clearDownloads() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return;
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch { /* ignore */ }
  }
}

/** Read the extension's `currentDownloadProgress` from service-worker storage. */
export async function getDownloadProgress(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) return null;
  return sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('currentDownloadProgress');
    return stored.currentDownloadProgress || null;
  });
}

/**
 * Wait for the batch ZIP (written via chrome.downloads.download from the
 * service worker) and return its on-disk path.
 */
export async function waitForZipDownload(context, timeout = 300_000) {
  return waitForFileDownloaded(context, (name) => name.endsWith('.zip'), timeout);
}

/**
 * Clear any leftover batch-download progress from a previous run.
 *
 * The extension persists `currentDownloadProgress` in chrome.storage.local and
 * restores it on popup open. A batch that was interrupted (or left in a
 * `running` state by a failed test) would otherwise disable the Download ZIP
 * button and make the next test look like a regression.
 */
export async function resetDownloadProgress(context) {
  const [sw] = context.serviceWorkers();
  if (!sw) return;
  await sw.evaluate(async () => {
    await chrome.storage.local.remove('currentDownloadProgress');
    if (typeof globalThis !== 'undefined') globalThis.currentDownloadProgress = null;
  });
}