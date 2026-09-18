/**
 * Harness smoke test — validates the e2e plumbing itself, independent of
 * YouTube. If this fails, the problem is the harness, not the extension.
 */
import { test, expect } from './fixtures.mjs';
import { openPopup, waitForPopupReady, isLoggedIn } from './helpers.mjs';

test('extension loads and service worker registers', async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test('popup opens and reaches a ready state', async ({ context, extensionId }) => {
  const yt = await context.newPage();
  await yt.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

  const popup = await openPopup(context, extensionId, yt);
  await waitForPopupReady(popup);

  const status = await popup.evaluate(
    () => document.getElementById('status')?.textContent || ''
  );
  expect(status).not.toContain('Initializing');
  expect(status.length).toBeGreaterThan(0);

});

test('profile login state is detectable', async ({ context }) => {
  const loggedIn = await isLoggedIn(context);
  // Informational: this test asserts the check works, not that you are logged in.
  expect(typeof loggedIn).toBe('boolean');
  test.info().annotations.push({
    type: 'login',
    description: loggedIn ? 'signed in' : 'not signed in (run npm run e2e:login)',
  });
});
