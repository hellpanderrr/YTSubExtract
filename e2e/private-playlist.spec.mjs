/**
 * Private playlist (Liked Videos / LL) — regression test for the credentialed
 * fetch fallback.
 *
 * This is the case that motivated the suite: unauthenticated InnerTube clients
 * return "The playlist does not exist" for LL, so extraction must fall through
 * to the content-script credentialed page fetch.
 *
 * Requires login (npm run e2e:login). Skips otherwise.
 */
import { test, expect } from './fixtures.mjs';
import {
  openPopup,
  waitForPlaylistReady,
  readPopupState,
  requireLogin,
  waitForBatchComplete,
  waitForZipDownload,
  clearDownloads,
  resetDownloadProgress,
  eraseDownloadHistory,
} from './helpers.mjs';
import { unzipSync } from 'fflate';
import fs from 'fs';

// Default to Liked Videos; override with E2E_PRIVATE_PLAYLIST_URL if needed.
const PRIVATE_URL = process.env.E2E_PRIVATE_PLAYLIST_URL
  || 'https://www.youtube.com/playlist?list=LL';

test.describe('private playlist (Liked Videos)', () => {
  test('loads videos via the credentialed-fetch fallback', async ({ context, extensionId }) => {
    await requireLogin(context, test);

    const yt = await context.newPage();
    // Land on the playlist, then reload so the popup observes it as the active tab.
    await yt.goto(PRIVATE_URL, { waitUntil: 'domcontentloaded' });
    await yt.waitForTimeout(4000);

    const popup = await openPopup(context, extensionId, yt);

    // The fallback is slower than the plain API path — allow generous time.
    await waitForPlaylistReady(popup, 1, 180_000);

    const state = await readPopupState(popup);
    expect(state.status).toContain('Loaded');
    expect(state.videoCount).toBeGreaterThan(0);

    // Regression guard: must NOT surface the unauthenticated error.
    expect(state.status).not.toContain('does not exist');
    expect(state.logs).not.toContain('The playlist does not exist');

  });

  // A private playlist must ALSO work end-to-end for batch download, not just
  // listing: the two use different pipelines (listing = DOM/credentialed fetch,
  // extraction = per-video tiers), so a green listing test does not cover it.
  test('batch ZIP downloads subtitles for a selected video', async ({ context, extensionId }) => {
    await requireLogin(context, test);
    clearDownloads();
    await resetDownloadProgress(context);
    await eraseDownloadHistory(context);

    const yt = await context.newPage();
    await yt.goto(PRIVATE_URL, { waitUntil: 'domcontentloaded' });
    await yt.waitForTimeout(4000);

    const popup = await openPopup(context, extensionId, yt);
    await waitForPlaylistReady(popup, 1, 180_000);

    // One video keeps the run fast and the assertion unambiguous.
    const selected = await popup.evaluate(() => {
      const boxes = Array.from(
        document.querySelectorAll('#playlist-videos input[type="checkbox"]')
      );
      boxes.forEach((cb, i) => {
        const want = i < 1;
        if (cb.checked !== want) {
          cb.checked = want;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      return boxes.filter((cb) => cb.checked).length;
    });
    expect(selected).toBe(1);

    await expect
      .poll(() => popup.evaluate(() => document.getElementById('btn-download-zip')?.disabled))
      .toBe(false);

    await popup.evaluate(() => document.getElementById('btn-download-zip').click());
    const state = await waitForBatchComplete(popup, 900_000);
    console.log(`[e2e] LL batch finished: ${state.status}`);

    const zipPath = await waitForZipDownload(context, 300_000);
    const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))));
    const subtitleEntries = entries.filter(
      (e) => /\.(srt|vtt|txt)$/i.test(e) && !/^_errors\.txt$/i.test(e)
    );
    console.log(`[e2e] LL ZIP entries: ${entries.join(', ') || '(none)'}`);

    // Strict: a Liked Videos entry the user chose must yield a real subtitle.
    // Set E2E_LL_EXPECT_SUCCESS=0 to accept an accounted-for failure instead.
    if (process.env.E2E_LL_EXPECT_SUCCESS !== '0') {
      expect(subtitleEntries.length).toBe(1);
    } else {
      expect(subtitleEntries.length + (entries.includes('_errors.txt') ? 1 : 0)).toBe(1);
    }
  });
});