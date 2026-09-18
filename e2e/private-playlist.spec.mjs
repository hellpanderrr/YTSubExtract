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
import { openPopup, waitForPlaylistReady, readPopupState, requireLogin } from './helpers.mjs';

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
});