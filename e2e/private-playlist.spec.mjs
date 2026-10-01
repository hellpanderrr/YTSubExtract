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

    // Liked Videos mixes long-form (captioned) with Shorts (often captionless),
    // and position 0 is whatever was liked most recently — so "first video"
    // is a lottery ticket, not a test. Walk long-form rows (duration ≥ 60s,
    // read from the rows' own `.video-duration` spans, not the row text whose
    // leading index looks like a duration) and take the first whose batch
    // actually yields a real subtitle. Per-row attempt is capped (~3 min) so
    // one BotGuard-blocked video (e.g. ASR-only tracks returning HTTP 200
    // with 0-byte bodies) doesn't eat the whole timeout; such rows fail fast
    // into _errors.txt, we clear state, and move to the next candidate.
    const durations = await popup.evaluate(() => Array.from(
      document.querySelectorAll('#playlist-videos .playlist-video-item'),
      (row) => row.querySelector('.video-duration')?.textContent?.trim() || ''
    ));
    const durSecs = (label) => {
      const m = (label || '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
      if (!m) return -1;
      return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    };
    const rowCount = durations.length;
    let zipPath = null;
    let subtitleEntries = [];
    let tried = 0;
    for (let pick = 0; pick < rowCount && pick < 15; pick++) {
      if (durSecs(durations[pick]) < 60) continue;
      tried++;
      await popup.evaluate((idx) => {
        const boxes = Array.from(
          document.querySelectorAll('#playlist-videos input[type="checkbox"]')
        );
        boxes.forEach((cb, i) => {
          const want = i === idx;
          if (cb.checked !== want) {
            cb.checked = want;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }, pick);
      await expect
        .poll(() => popup.evaluate(() => document.getElementById('btn-download-zip')?.disabled))
        .toBe(false);
      await popup.evaluate(() => document.getElementById('btn-download-zip').click());
      // Bounded attempt: a captionless/BotGuard-blocked row fails into
      // _errors.txt quickly; a farms-out-to-Tab-Navigation row takes longer.
      // 3 minutes per row keeps the suite moving without cutting real work.
      let state;
      try {
        state = await waitForBatchComplete(popup, 180_000);
      } catch {
        state = await readPopupState(popup);
      }
      console.log(`[e2e] LL row ${pick} batch: ${state.status}`);
      zipPath = await waitForZipDownload(context, 60_000).catch(() => null);
      if (zipPath) {
        const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))));
        subtitleEntries = entries.filter(
          (e) => /\.(srt|vtt|txt)$/i.test(e) && !/^_errors\.txt$/i.test(e)
        );
        console.log(`[e2e] LL row ${pick} ZIP: ${entries.join(', ') || '(none)'}`);
        if (subtitleEntries.length === 1) break;
      }
      // Not this row — clear batch state so the next attempt starts clean.
      clearDownloads();
      await resetDownloadProgress(context);
      await eraseDownloadHistory(context);
      zipPath = null;
      subtitleEntries = [];
    }
    console.log(`[e2e] LL batch tried ${tried} long-form row(s)`);

    // Strict: some Liked Videos entry must yield a real subtitle.
    // Set E2E_LL_EXPECT_SUCCESS=0 to accept an accounted-for failure instead.
    if (process.env.E2E_LL_EXPECT_SUCCESS !== '0') {
      expect(subtitleEntries.length).toBe(1);
    } else {
      expect(tried).toBeGreaterThan(0);
    }
  });
});