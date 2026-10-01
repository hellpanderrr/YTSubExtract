/**
 * Public playlist listing.
 *
 * Set E2E_PLAYLIST_URL to a public playlist to run this. Without it the test
 * skips with a clear message rather than failing.
 */
import { test, expect } from './fixtures.mjs';
import { openPopup, waitForPlaylistReady, readPopupState } from './helpers.mjs';

const PLAYLIST_URL = process.env.E2E_PLAYLIST_URL;

test.describe('public playlist listing', () => {
  test.skip(!PLAYLIST_URL, 'Set E2E_PLAYLIST_URL to a public playlist URL to run this test.');

  test('loads the video list and populates the selection UI', async ({ context, extensionId }) => {
    const yt = await context.newPage();
    await yt.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });
    await yt.waitForTimeout(3000);

    const popup = await openPopup(context, extensionId, yt);
    await waitForPlaylistReady(popup, 1);

    const state = await readPopupState(popup);
    expect(state.playlistMode).toBe(true);
    expect(state.videoCount).toBeGreaterThan(0);
    expect(state.status).toContain('Loaded');
    expect(state.selectedCount).toMatch(/\d+ selected/);
    expect(state.zipEnabled).toBe(true);

  });

  test('select-all checkbox toggles every row', async ({ context, extensionId }) => {
    const yt = await context.newPage();
    await yt.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });
    await yt.waitForTimeout(3000);

    const popup = await openPopup(context, extensionId, yt);
    await waitForPlaylistReady(popup, 1);

    // Uncheck select-all -> all rows unselected, ZIP disabled.
    await popup.evaluate(() => {
      const el = document.getElementById('select-all');
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => popup.evaluate(() => document.getElementById('selected-count')?.textContent || ''))
      .toContain('0 selected');
    expect(await popup.evaluate(() => document.getElementById('btn-download-zip')?.disabled)).toBe(true);

    // Re-check -> rows selected again, ZIP enabled.
    await popup.evaluate(() => {
      const el = document.getElementById('select-all');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => popup.evaluate(() => document.getElementById('btn-download-zip')?.disabled))
      .toBe(false);

  });
});