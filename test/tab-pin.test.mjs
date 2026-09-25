// Unit tests for batch driver-tab pinning and stop checkpoints in
// translation-manager.mjs — the tab-follows-focus bug and its guards.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, waitFor } from './helpers/chrome-mock.mjs';

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

test('a dead pin falls back to active-or-first AND re-pins the fallback', async () => {
  state.tabs.push({ id: 1, url: 'https://www.youtube.com/', active: true });
  tm._batchTabId = 99; // closed — not in the mock

  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 1);
  // The replacement becomes the new pin: without this, every later leg and
  // the final restore re-follow the user's focus (the original bug).
  assert.equal(tm._batchTabId, 1, 'fallback must be re-pinned, not just returned');
});

test('a pin whose tab left youtube.com is NOT released (no one-way door)', async () => {
  // A transient URL mismatch (mid-navigation state, youtube-nocookie, or the
  // user browsing elsewhere in the batch tab) must not drop the pin —
  // releasing it reverts the batch to follow-the-focus behavior.
  state.tabs.push(
    { id: 1, url: 'https://www.youtube.com/', active: true },
    { id: 5, url: 'https://example.com/somewhere', active: false }
  );
  tm._batchTabId = 5;

  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 5, 'pin stays authoritative even off youtube.com');
  assert.equal(tm._batchTabId, 5, 'pin must not be released on URL mismatch');
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

test('Tier 1.7 and 2C cannot overlap on the shared tab (one page-leg lock)', async () => {
  state.tabs.push({ id: 3, url: 'https://www.youtube.com/watch?v=seed', active: true });
  tm._batchTabId = 3;
  tm._originalTabUrl = 'https://www.youtube.com/playlist?list=PLunit';

  // Hold the coercion's sendMessage open — that worker owns the lock.
  let releaseCoerce = null;
  state.sendMessageHandler = (tabId, message) => {
    if (message.type === 'COERCE_PLAYER_TRANSCRIPT') {
      return new Promise((resolve) => {
        releaseCoerce = () =>
          resolve({ success: true, result: [{ start: 0, duration: 1, text: 'a' }] });
      });
    }
    return { success: false, error: 'nope' };
  };

  try {
    const coerceP = tm._coercePlayerTranscript('vidA', { timeout: 5000 });
    await waitFor(() => releaseCoerce !== null, { label: 'coercion holds the lock' });

    // 2C queued behind 1.7: must NOT navigate while coercion is in flight.
    const navP = tm._fetchTranscriptViaTabNav('vidB', { timeout: 250 });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      state.tabUpdates.length,
      0,
      '2C must not navigate the tab while 1.7 holds the page-leg lock'
    );

    releaseCoerce();
    const coerced = await coerceP;
    assert.equal(coerced.length, 1);

    // Lock released → 2C proceeds and navigates (then times out: the mock
    // never fires tabs.onUpdated complete, so no polling starts).
    const nav = await navP;
    assert.ok(state.tabUpdates.length >= 1, '2C navigates after the lock is released');
    assert.equal(nav, null);
    assert.equal(state.tabUpdates[0].id, 3, 'navigation targets the pinned tab');
  } finally {
    state.sendMessageHandler = null;
    if (releaseCoerce) releaseCoerce();
  }
});

test('_probeSettledNoTracks runs its probe in MAIN world and fails safe', async () => {
  const mkPlayer = (videoId, tracks) => ({
    getPlayerResponse: () => ({
      videoDetails: { videoId },
      captions: tracks
        ? { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
        : undefined,
    }),
  });

  const runProbe = async (playerValue) => {
    state.scriptingHandler = async (opts) => {
      assert.equal(opts.world, 'MAIN', 'probe must run in MAIN world');
      assert.equal(opts.target.tabId, 4);
      const savedDoc = globalThis.document;
      globalThis.document = { getElementById: () => playerValue };
      try {
        return [{ result: opts.func(...opts.args) }];
      } finally {
        globalThis.document = savedDoc;
      }
    };
    try {
      return await tm._probeSettledNoTracks(4, 'vidZ');
    } finally {
      state.scriptingHandler = null;
    }
  };

  // Settled on our video, zero tracks → fast-abort candidate
  const zero = await runProbe(mkPlayer('vidZ', []));
  assert.deepEqual(zero, { settled: true, trackCount: 0 });

  // Settled with tracks → keep waiting
  const some = await runProbe(
    mkPlayer('vidZ', [{ languageCode: 'en' }])
  );
  assert.deepEqual(some, { settled: true, trackCount: 1 });

  // Wrong video (mid-navigation) → not settled
  const wrongVideo = await runProbe(mkPlayer('otherVid', []));
  assert.deepEqual(wrongVideo, { settled: false });

  // No page API visible (ISOLATED-style dead player) → not settled
  const noApi = await runProbe({ notAPlayer: true });
  assert.deepEqual(noApi, { settled: false });

  // executeScript throwing (tab mid-nav) → not settled, never a false abort
  state.scriptingHandler = async () => {
    throw new Error('No document with id movie_player');
  };
  try {
    const failed = await tm._probeSettledNoTracks(4, 'vidZ');
    assert.deepEqual(failed, { settled: false });
  } finally {
    state.scriptingHandler = null;
  }
});

test('a throwing page-leg cannot poison the lock chain', async () => {
  state.tabs.push({ id: 1, url: 'https://www.youtube.com/', active: true });
  tm._batchTabId = 1;
  const orig = tm._resolvePageLegTab.bind(tm);

  // First call: the leg's tab resolution throws synchronously inside the
  // lock executor — this caller is lost (no timer started yet), but the
  // CHAIN must survive. Without the _enqueuePageLeg .catch, _pageLegLock
  // stays rejected forever and every later leg silently stalls.
  tm._resolvePageLegTab = () => {
    throw new Error('synthetic executor failure');
  };
  tm._coercePlayerTranscript('v1', { timeout: 500 }); // abandoned on purpose
  await new Promise((r) => setTimeout(r, 30));
  tm._resolvePageLegTab = orig;

  // Second leg must fully execute (reach sendMessage) — with a poisoned
  // chain its executor never runs and this await hangs forever, so race it
  // against a hang detector.
  const before = state.sentMessages.length;
  const second = await Promise.race([
    tm._coercePlayerTranscript('v2', { timeout: 2000 }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('second leg hung — lock chain poisoned')), 800)
    ),
  ]);
  assert.ok(
    state.sentMessages.length > before,
    'second leg must reach sendMessage — chain not poisoned'
  );
  assert.equal(second, null);
});

test('re-pin re-captures the restore target from the replacement tab', async () => {
  state.tabs.push(
    { id: 1, url: 'https://www.youtube.com/feed/subscriptions', active: true },
    { id: 7, url: 'https://www.youtube.com/@somechannel/videos', active: false }
  );
  // Batch seeded tab 42 (now closed); restore would carry ITS url
  tm._batchTabId = 42;
  tm._originalTabUrl = 'https://www.youtube.com/playlist?list=PLdead';

  const tab = await tm._resolvePageLegTab();
  assert.equal(tab.id, 1, 'fallback picked');
  assert.equal(tm._batchTabId, 1, 're-pinned');
  // The replacement tab must be restored to ITS OWN page, not the dead
  // tab's playlist URL (round-3 review).
  assert.equal(
    tm._originalTabUrl,
    'https://www.youtube.com/feed/subscriptions',
    'restore target re-captured from the replacement tab'
  );
});
