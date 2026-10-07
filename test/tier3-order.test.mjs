import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers/chrome-mock.mjs';

installChrome();

// Pin the 2026-09-27 demotion: Tier 1 (InnerTube client chain) must be tried
// before Tier 3 (youtubei.js) in the playlist chain. Tier 3 had 0 successes
// across every available real batch run (see docs/LESSONS.md 2026-09-27) but
// used to run FIRST, taxing every video before the tier that actually works.
// A mutant that swaps the two blocks back must fail this test.

const calls = [];

mock.module('../src/utils/youtube-caption-extractor.js', {
  namedExports: {
    getSubtitles: async () => {
      calls.push('tier1');
      return [{ start: 0, duration: 1, text: 'hi' }];
    },
    getLanguages: async () => [],
    getVideoInfo: async () => ({}),
    getTranscriptViaAndroid: async () => null,
    getTranscriptViaNext: async () => null,
  },
});

mock.module('../src/background/tier3-worker.mjs', {
  namedExports: {
    fetchTier3Transcript: async () => {
      calls.push('tier3');
      return { segments: [{ start: 0, end: 1, text: 'hi' }], language: 'en' };
    },
    getVideoMetadata: async () => ({ title: '', languages: [] }),
  },
});

const { translationManager: tm } = await import('../src/background/translation-manager.mjs');

test('Tier 1 is attempted before Tier 3 in the playlist chain, and Tier 1 success skips Tier 3 entirely', async () => {
  const result = await tm.getTranscriptForPlaylist(`order-check-${Date.now()}`, {});
  assert.equal(result.source, 'tier1-playlist');
  assert.deepEqual(calls, ['tier1']);
});
