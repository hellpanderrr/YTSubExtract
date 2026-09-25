// Unit tests for the batch Stop state machine (background SW).
// Covers the adversarial-review findings on 87c2d49:
//   - STOP must refuse during finalization (CRITICAL clobber race)
//   - accepted Stop → 'stopping' → terminal 'stopped'
//   - zero-success stop ships no ZIP
//   - failure after an accepted Stop reports 'stopped', not 'error'
//
// Runs against the real main.mjs message handler with translationManager's
// network-facing methods patched (no YouTube, no navigation).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, waitFor, deferred } from './helpers/chrome-mock.mjs';

const { state, send } = installChrome();
const { translationManager: tm } = await import(
  '../src/background/translation-manager.mjs'
);
await import('../src/background/main.mjs'); // registers the onMessage listener

const progress = () => state.storageData.get('currentDownloadProgress');

const video = (id, i) => ({ videoId: id, title: `Title ${id}`, index: i });
const okResult = () => ({
  source: 'unit-test',
  result: [{ start: 0, duration: 1, text: 'hello' }],
  logs: [],
});
const batchMsg = (videos, options = {}) => ({
  type: 'BATCH_DOWNLOAD_PLAYLIST',
  videos,
  playlistId: 'PLunit',
  playlistTitle: 'Unit Playlist',
  options: { format: 'srt', sourceLang: 'en', translate: false, ...options },
});

beforeEach(() => {
  // Module-level state that outlives a single test
  globalThis.isBatchProcessing = false;
  globalThis.activeBatchProcessor = null;
  globalThis.batchFinalizing = false;
  globalThis.batchTerminalStatus = null;
  globalThis.currentDownloadProgress = null;
  tm._batchCancelled = false;
  tm._batchTabId = null;
  tm._originalTabUrl = null;
  // storage/download state
  state.storageData.clear();
  state.downloads.length = 0;
  state.tabUpdates.length = 0;
  state.downloadMode = 'ok';
  state.storageLatencyMs = 0;
  // network/navigation seams: no real YouTube in unit tests
  tm.seedWatchPage = async () => true;
  tm.restoreOriginalTab = async () => {};
});

test('STOP with no batch running is refused', async () => {
  const resp = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(resp.success, false);
  assert.equal(resp.error, 'No batch running');
  assert.equal(progress(), undefined);
});

test('STOP during finalization refuses and cannot clobber the terminal status', async () => {
  // Gate restore so the batch sits in finalization (terminal status written,
  // guard still held) — the exact window the CRITICAL finding was about.
  const restoreGate = deferred();
  tm.getTranscriptForPlaylist = async () => okResult();
  tm.restoreOriginalTab = async () => {
    await restoreGate.promise;
  };

  const resp = await send(batchMsg([video('a', 1), video('b', 2)]));
  assert.equal(resp.success, true);

  await waitFor(() => progress()?.status === 'completed', {
    label: 'terminal write while restore is gated',
  });
  // Finalizing: the batch guard is still held — STOP would previously pass.
  assert.equal(globalThis.isBatchProcessing, true);

  const stop = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop.success, false);
  assert.equal(stop.error, 'Batch already finished');
  // Terminal status untouched — this write used to soft-lock the popup.
  assert.equal(progress().status, 'completed');
  assert.equal(progress().swDownloaded, true);

  restoreGate.resolve();
  await waitFor(() => globalThis.isBatchProcessing === false, {
    label: 'guard reset after restore',
  });
  // Post-finalize STOP hits the other guard, still refused.
  const stop2 = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop2.success, false);
  assert.equal(stop2.error, 'No batch running');
  assert.equal(progress().status, 'completed');
});

test('Stop mid-batch: stopping → stopped, silent partial ZIP, idempotent second Stop', async () => {
  const gates = [deferred(), deferred()];
  let calls = 0;
  tm.getTranscriptForPlaylist = async () => {
    const gate = gates[calls++];
    await gate.promise;
    return okResult();
  };

  const resp = await send(batchMsg([video('x1', 1), video('x2', 2)]));
  assert.equal(resp.success, true);

  // Both workers in flight (concurrency 3)
  await waitFor(() => calls === 2, { label: 'both videos in flight' });

  const stop1 = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop1.success, true);
  await waitFor(() => progress()?.status === 'stopping', {
    label: "status 'stopping'",
  });

  // Second Stop while already stopping: idempotent success, no state damage
  const stop2 = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop2.success, true);

  // In-flight videos resolve; batch finishes as stopped
  for (const gate of gates) gate.resolve();
  await waitFor(() => progress()?.status === 'stopped', {
    label: "terminal 'stopped'",
  });

  const p = progress();
  assert.equal(p.completed, 2);
  assert.equal(p.failed, 0);
  // Partial ZIP saved SILENTLY (no Save-As dialog after a Stop)
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].saveAs, false);
  assert.equal(p.swDownloaded, true);
  assert.equal(p.stoppedSaved, true);

  await waitFor(() => globalThis.isBatchProcessing === false, {
    label: 'guard reset',
  });
});

test('Stop with zero successes ships no ZIP and reports stopped', async () => {
  const gate = deferred();
  let calls = 0;
  tm.getTranscriptForPlaylist = async (videoId) => {
    calls++;
    await gate.promise;
    const err = new Error(`Batch stopped for ${videoId}`);
    err.stopped = true;
    throw err; // exactly what throwIfStopped produces
  };

  await send(batchMsg([video('z1', 1), video('z2', 2)]));
  await waitFor(() => calls >= 1, { label: 'first video started' });

  const stop = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop.success, true);
  gate.resolve();

  await waitFor(() => progress()?.status === 'stopped', {
    label: "terminal 'stopped'",
  });
  const p = progress();
  // Nothing to deliver → no download at all, and stopped videos are
  // NOT counted as failures.
  assert.equal(state.downloads.length, 0);
  assert.equal(p.completed, 0);
  assert.equal(p.failed, 0);
  assert.equal(p.total, 2);

  await waitFor(() => globalThis.isBatchProcessing === false);
});

test('failure after an accepted Stop reports stopped, not error (err.wasStopped)', async () => {
  const gate = deferred();
  let inFlight = false;
  tm.getTranscriptForPlaylist = async () => {
    inFlight = true; // worker is past its shouldStop checks and awaiting us
    await gate.promise;
    return okResult();
  };

  // format:123 reaches formatTranscript's `format.toLowerCase()` in the ZIP
  // loop and throws — a deterministic failure inside the batch try-block.
  const resp = await send(batchMsg([video('f1', 1)], { format: 123 }));
  assert.equal(resp.success, true);

  // Wait until the video is genuinely in flight, otherwise Stop could skip
  // it before it starts and the ZIP-phase throw would never happen.
  await waitFor(() => inFlight, { label: 'video in flight before Stop' });

  const stop = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop.success, true);
  gate.resolve();

  await waitFor(() => progress() && progress().status === 'stopped', {
    label: "terminal 'stopped' after ZIP-phase failure",
  });
  // The user pressed Stop — the terminal state must be 'stopped',
  // never 'error'.
  assert.notEqual(progress().status, 'error');
  assert.equal(progress().status, 'stopped');

  await waitFor(() => globalThis.isBatchProcessing === false, {
    label: 'guard reset after failure path',
  });
});

test('a new batch clears a stale stop flag from a previous run', async () => {
  tm._batchCancelled = true; // stale: e.g. SW alive, previous batch died oddly
  tm._batchTabId = 12345;
  let seenFlag = null;
  tm.getTranscriptForPlaylist = async () => {
    seenFlag = tm._batchCancelled;
    return okResult();
  };

  await send(batchMsg([video('n1', 1)]));
  await waitFor(() => progress()?.status === 'completed', {
    label: 'batch completes',
  });
  // BATCH handler must reset the stale flag before workers run
  assert.equal(seenFlag, false);
  assert.equal(tm._batchTabId, null);
});

test('STOP write is awaited — status is "stopping" the moment the response arrives', async () => {
  const gate = deferred();
  let inFlight = false;
  tm.getTranscriptForPlaylist = async () => {
    inFlight = true;
    await gate.promise;
    return okResult();
  };

  await send(batchMsg([video('w1', 1)]));
  await waitFor(() => inFlight, { label: 'video in flight' });

  // Slow storage: with a fire-and-forget write the response would arrive
  // before the write lands and this assertion would read the old status.
  state.storageLatencyMs = 40;
  const stop = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop.success, true);
  // No waitFor here — that is the point of the test.
  assert.equal(progress()?.status, 'stopping', 'write must complete before sendResponse');

  state.storageLatencyMs = 0;
  gate.resolve();
  await waitFor(() => progress()?.status === 'stopped');
});

test('STOP refuses to clobber a terminal status that won the race, without mutating state', async () => {
  // Guard still held (isBatchProcessing) and finalizing flag clear — the
  // pre-fix handler would pass both checks and force 'stopping' over this.
  globalThis.isBatchProcessing = true;
  globalThis.batchFinalizing = false;
  state.storageData.set('currentDownloadProgress', {
    playlistId: 'PLunit',
    status: 'completed',
    completed: 2,
    total: 2,
    failed: 0,
    updatedAt: Date.now(),
  });

  const stop = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop.success, false);
  assert.equal(stop.error, 'Batch already finished');
  assert.equal(progress().status, 'completed', 'terminal status must survive');
  assert.equal(tm._batchCancelled, false, 'refused stop must not set the cancel flag');

  globalThis.isBatchProcessing = false;
});

test('Stop skips queued videos — they never enter extraction at all', async () => {
  const gate = deferred();
  let calls = 0;
  tm.getTranscriptForPlaylist = async () => {
    calls++;
    if (calls === 1) await gate.promise; // first video holds the stop window
    return okResult();
  };

  // 5 videos, concurrency 3 → videos 4 and 5 queue on the semaphore
  const videos = [1, 2, 3, 4, 5].map((i) => video(`q${i}`, i));
  const resp = await send(batchMsg(videos));
  assert.equal(resp.success, true);
  await waitFor(() => calls === 3, { label: 'three workers in flight' });

  const stop = await send({ type: 'STOP_BATCH_DOWNLOAD' });
  assert.equal(stop.success, true);
  gate.resolve();

  await waitFor(() => progress()?.status === 'stopped', {
    label: "terminal 'stopped'",
  });
  // Videos 4 and 5 were queued; shouldStop must skip them before extraction.
  assert.equal(calls, 3, 'queued videos must never reach getTranscriptForPlaylist');
  assert.equal(progress().completed, 3, 'only the in-flight videos count as done');
  assert.equal(progress().total, 5);
  assert.equal(progress().failed, 0, 'skipped videos are not failures');
});

test('batch pins the click-time tabId from the payload, not the active tab', async () => {
  state.tabs.push(
    { id: 1, url: 'https://www.youtube.com/feed/subscriptions', active: true },
    { id: 2, url: 'https://www.youtube.com/playlist?list=PLunit', active: false },
    { id: 9, url: 'https://example.com/elsewhere', active: false }
  );
  let pinDuringRun = null;
  tm.getTranscriptForPlaylist = async () => {
    pinDuringRun = tm._batchTabId;
    return okResult();
  };

  // Click-time tab (2) is NOT the active tab (1) — e.g. user switched
  // during a cold service-worker wake.
  const resp = await send({ ...batchMsg([video('p1', 1)]), tabId: 2 });
  assert.equal(resp.success, true);
  await waitFor(() => progress()?.status === 'completed', { label: 'batch done' });
  await waitFor(() => globalThis.isBatchProcessing === false, { label: 'guard released' });
  assert.equal(pinDuringRun, 2, 'must pin the click-time tab, not the active one');

  // A click-time tab that is not a YouTube tab must not be pinned.
  state.storageData.clear();
  globalThis.currentDownloadProgress = null;
  pinDuringRun = 'unset';
  const resp2 = await send({ ...batchMsg([video('p2', 1)]), tabId: 9 });
  assert.equal(resp2.success, true);
  await waitFor(() => progress()?.status === 'completed', { label: 'second batch done' });
  assert.equal(pinDuringRun, null, 'non-YouTube click tab must not be pinned');
});
