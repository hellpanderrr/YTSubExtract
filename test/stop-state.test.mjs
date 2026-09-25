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
  globalThis.currentDownloadProgress = null;
  tm._batchCancelled = false;
  tm._batchTabId = null;
  tm._originalTabUrl = null;
  // storage/download state
  state.storageData.clear();
  state.downloads.length = 0;
  state.tabUpdates.length = 0;
  state.downloadMode = 'ok';
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
