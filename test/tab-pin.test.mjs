// Unit tests for batch driver-tab pinning and stop checkpoints in
// translation-manager.mjs — the tab-follows-focus bug and its guards.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers/chrome-mock.mjs';

const { state } = installChrome();
const { translationManager: tm } = await import(
  '../src/background/translation-manager.mjs'
);

beforeEach(() => {
  tm._batchTabId = null;
  tm._batchCancelled = false;
  tm._originalTabUrl = null;
  state.tabs.length = 0;
  state.tabUpdates.length = 0;
  state.sentMessages.length = 0;
});

test('_resolvePageLegTab drives the pinned tab even when another is active', async () => {
  state.tabs.push(
    { id: 1, url: 'https://www.youtube.com/feed/subscriptions', active: true },
    { id: 2, url: 'https://www.youtube.com/watch?v=abc', active: false }
  );
  tm._batchTabId = 2; // batch seeded tab 2; user switched to tab 1

  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 2, 'must not follow the user focus');
});

test('a dead pin falls back to active-or-first and clears the pin', async () => {
  state.tabs.push({ id: 1, url: 'https://www.youtube.com/', active: true });
  tm._batchTabId = 99; // closed — not in the mock

  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 1);
  assert.equal(tm._batchTabId, null, 'dead pin must be released');
});

test('a pin whose tab left youtube.com is released', async () => {
  state.tabs.push(
    { id: 1, url: 'https://www.youtube.com/', active: true },
    { id: 5, url: 'https://example.com/somewhere', active: false }
  );
  tm._batchTabId = 5; // user navigated the batch tab away themselves

  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 1);
  assert.equal(tm._batchTabId, null);
});

test('without a pin behavior is unchanged (active, else first)', async () => {
  state.tabs.push(
    { id: 3, url: 'https://www.youtube.com/', active: false },
    { id: 4, url: 'https://www.youtube.com/watch?v=x', active: true }
  );
  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 4);

  state.tabs.length = 0;
  state.tabs.push({ id: 9, url: 'https://www.youtube.com/', active: false });
  const only = await tm._resolvePageLegTab();
  assert.equal(only.id, 9);
});

test('cancel checkpoints: coercion and tab-nav never touch the tab when stopped', async () => {
  tm._batchCancelled = true;

  const coerced = await tm._coercePlayerTranscript('vid1', { timeout: 5000 });
  assert.equal(coerced, null);

  const nav = await tm._fetchTranscriptViaTabNav('vid1', { timeout: 5000 });
  assert.equal(nav, null);

  assert.equal(state.sentMessages.length, 0, 'no content message sent');
  assert.equal(state.tabUpdates.length, 0, 'no navigation issued');
});

test('stop checkpoint aborts the batch chain before any network tier', async () => {
  let networkTouched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkTouched = true;
    throw new Error('network must not be reached in unit test');
  };
  tm._batchCancelled = true;

  try {
    await assert.rejects(
      tm.getTranscriptForPlaylist(`unit-vid-${Date.now()}`, {
        sourceLang: 'en',
        translate: false,
      }),
      (err) => err.stopped === true && /Batch stopped/.test(err.message)
    );
    assert.equal(networkTouched, false, 'tier 0 must never run');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('restoreOriginalTab restores the pinned tab and clears all batch flags', async () => {
  state.tabs.push(
    { id: 1, url: 'https://www.youtube.com/', active: true },
    { id: 7, url: 'https://www.youtube.com/watch?v=zzz', active: false }
  );
  const original = 'https://www.youtube.com/playlist?list=PLunit';
  tm._originalTabUrl = original;
  tm._batchTabId = 7;
  tm._batchCancelled = true;

  await tm.restoreOriginalTab();

  const upd = state.tabUpdates.find((u) => u.id === 7);
  assert.ok(upd, 'the pinned tab (7) must be restored — not the active one');
  assert.equal(upd.url, original);
  assert.equal(state.tabUpdates.length, 1, 'only the pinned tab is touched');
  assert.equal(tm._originalTabUrl, null);
  assert.equal(tm._batchTabId, null);
  assert.equal(tm._batchCancelled, false, 'restore clears the stop flag');
});
