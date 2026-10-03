import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, waitFor } from './helpers/chrome-mock.mjs';

// seedWatchPage navigates the user's tab to a /watch page (and restores it at
// the end) so Tier 1.7 (and 2C, untranslated) has a real player to drive.
// NOTE: until 2026-10-03 this file documented the opposite contract (a
// translated batch skipped the seed because 1.7/2C were skipped as
// untranslatable). 1.7 gained translation support that day — it is the seed's
// main reader for translated batches now.

const { state, send } = installChrome();
const { translationManager: tm } = await import('../src/background/translation-manager.mjs');
await import('../src/background/main.mjs'); // registers the onMessage listener

const progress = () => state.storageData.get('currentDownloadProgress');
let seedCalls;

const batchMsg = (options) => ({
  type: 'BATCH_DOWNLOAD_PLAYLIST',
  videos: [{ videoId: 'vidA', title: 'A', index: 1 }],
  playlistId: 'PLunit',
  playlistTitle: 'Unit Playlist',
  options: { format: 'srt', sourceLang: 'en', targetLang: 'ru', ...options },
});

beforeEach(() => {
  globalThis.isBatchProcessing = false;
  globalThis.activeBatchProcessor = null;
  globalThis.batchFinalizing = false;
  globalThis.batchTerminalStatus = null;
  globalThis.currentDownloadProgress = null;
  tm._batchCancelled = false;
  tm._batchTabId = null;
  tm._originalTabUrl = null;
  state.storageData.clear();
  state.downloads.length = 0;
  state.tabUpdates.length = 0;
  state.downloadMode = 'ok';
  state.storageLatencyMs = 0;
  seedCalls = 0;
  tm.seedWatchPage = async () => {
    seedCalls++;
    return true;
  };
  tm.restoreOriginalTab = async () => {};
  tm.getTranscriptForPlaylist = async () => ({
    source: 'unit-test',
    result: [{ start: 0, duration: 1, text: 'hello' }],
    logs: [],
  });
});

async function runBatch(options) {
  const resp = await send(batchMsg(options));
  assert.equal(resp.success, true);
  await waitFor(() => progress()?.status === 'completed', { label: 'batch completes' });
  await waitFor(() => globalThis.isBatchProcessing === false, { label: 'guard reset' });
}

test('an untranslated batch seeds the watch page once (control)', async () => {
  await runBatch({ translate: false });
  assert.equal(seedCalls, 1);
});

test('a translated batch DOES seed the watch page (1.7 became translation-capable)', async () => {
  // Reversed 2026-10-03: Tier 1.7 now arms a translationLanguage and the
  // capture is accepted only with a matching tlang, so a translated batch
  // reads the seeded player again. With API tiers bot-checked it is the tier
  // that actually works (ISSUES #3/#21). The header comment at the top of
  // this file predates the reversal.
  await runBatch({ translate: true });
  assert.equal(seedCalls, 1, '1.7 reads the seeded player for translated batches again');
});

test('a batch with no translate flag at all still seeds (undefined is not "translated")', async () => {
  await runBatch({});
  assert.equal(seedCalls, 1);
});
