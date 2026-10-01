// Unit tests for TranslationManager.seedWatchPage (background SW).
// The seed's contract is a *usable* player (loadVideoById present), not an
// attested tracklist: sustained API-ready probes return early instead of
// burning the whole loop waiting for captions a captionless seed video can
// never confirm. Runs against the real method with chrome.* mocked
// (test/helpers/chrome-mock.mjs) — no YouTube, no navigation. The loop's
// sleep is injected as 0ms so the suite costs no wall time.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers/chrome-mock.mjs';

const { state } = installChrome();
const { translationManager: tm } = await import(
  '../src/background/translation-manager.mjs'
);

const VID = 'FYlooNpGNxk';
const watchUrl = `https://www.youtube.com/watch?v=${VID}&autoplay=0`;

const readyNoTracks = (over = {}) => ({
  ready: true,
  hasCaptions: false,
  hasPlayer: true,
  trackCount: 0,
  tracks: [],
  playerState: 1,
  url: watchUrl,
  ...over,
});

// seed() pins sleepMs=0: probe sequencing (counts, streak resets) is what's
// asserted — wall-clock bounds on a 1s production sleep belong to e2e, where
// the browser and the player are real.
const seed = (script) => {
  // Substitute the default only when the script is exhausted — a scripted
  // null must reach the probe as a real dropped response (?? would eat it).
  state.sendMessageHandler = () => (script.length ? script.shift() : readyNoTracks());
  return tm.seedWatchPage(VID, null, 45000, 0);
};

beforeEach(() => {
  tm._batchTabId = null;
  tm._originalTabUrl = null;
  // Tab already on the seed video: skips navigation (and its 30s
  // onUpdated fallback + 3s settle) so tests exercise only the probe loop.
  state.tabs = [{ id: 7, url: watchUrl, active: true }];
  state.sentMessages = [];
  state.sendMessageHandler = null;
});

test('attested tracklist returns true on the first probe', async () => {
  const script = [readyNoTracks({ hasCaptions: true, trackCount: 2, tracks: ['en', 'ru'] })];
  assert.equal(await seed(script), true);
  // No polling needed: the single scripted probe was consumed, and the
  // fallback default never fired.
  assert.equal(script.length, 0);
});

test('sustained API-ready without tracklist returns true on the second probe', async () => {
  // Two scripted readies, then nothing: if the streak logic regresses, the
  // loop falls through to the fallback default (also ready) but consumes
  // extra probes — so assert exactly two probes were sent.
  const script = [readyNoTracks(), readyNoTracks()];
  assert.equal(await seed(script), true);
  assert.equal(script.length, 0);
  assert.equal(state.sentMessages.length, 2);
});

test('a not-ready probe resets the streak', async () => {
  const script = [
    readyNoTracks(),
    { ready: false, hasPlayer: true, url: watchUrl },
    readyNoTracks(),
    readyNoTracks(),
  ];
  assert.equal(await seed(script), true);
  // 4 probes consumed: ready, gap, ready, ready — the gap broke streak 1.
  assert.equal(script.length, 0);
  assert.equal(state.sentMessages.length, 4);
});

test('a dropped (null) probe resets the streak', async () => {
  const script = [readyNoTracks(), null, readyNoTracks(), readyNoTracks()];
  assert.equal(await seed(script), true);
  // Same shape as the not-ready gap: null is a gap, not a still-ready vote.
  assert.equal(script.length, 0);
  assert.equal(state.sentMessages.length, 4);
});

test('probe errors reset the streak and are logged verbatim', async () => {
  const script = [
    readyNoTracks(),
    { __err: 'Could not establish connection. Receiving end does not exist.' },
    readyNoTracks(),
    readyNoTracks(),
  ];
  assert.equal(await seed(script), true);
  assert.equal(script.length, 0);
  assert.equal(state.sentMessages.length, 4);
});
