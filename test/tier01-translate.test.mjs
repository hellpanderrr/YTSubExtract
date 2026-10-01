import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers/chrome-mock.mjs';

installChrome();

// Tier 0.1 (/next panel transcript) has no translation path:
// getTranscriptViaNext never reads its options. It runs BEFORE Tier 1, so for a
// translated request it would pre-empt Tier 1's correct &tlang= path and ship
// source-language text labelled as translated. It must be skipped when
// translation is requested, and still run when it is not.

let calls;

mock.module('../src/utils/youtube-caption-extractor.js', {
  namedExports: {
    getSubtitles: async () => {
      calls.push('tier1');
      return [{ start: 0, duration: 1, text: 'hi' }];
    },
    getLanguages: async () => [],
    getVideoInfo: async () => ({}),
    getTranscriptViaAndroid: async () => {
      calls.push('tier0');
      return null;
    },
    getTranscriptViaNext: async () => {
      calls.push('tier0.1');
      return null;
    },
  },
});

mock.module('../src/background/tier3-worker.mjs', {
  namedExports: {
    fetchTier3Transcript: async () => {
      calls.push('tier3');
      return null;
    },
    getVideoMetadata: async () => ({ title: '', languages: [] }),
  },
});

const { translationManager: tm } = await import('../src/background/translation-manager.mjs');

beforeEach(() => {
  calls = [];
});

test('a translated request skips Tier 0.1 and goes on to Tier 1', async () => {
  const result = await tm.getTranscriptForPlaylist(`tr-yes-${Date.now()}`, {
    sourceLang: 'auto',
    translate: true,
    targetLang: 'ru',
  });
  assert.equal(result.source, 'tier1-playlist');
  assert.ok(calls.includes('tier0'), 'Tier 0 still runs (it handles translate itself)');
  assert.ok(!calls.includes('tier0.1'), 'Tier 0.1 cannot translate and must be skipped');
  assert.ok(calls.includes('tier1'));
});

test('control: an untranslated request still tries Tier 0.1 before Tier 1', async () => {
  const result = await tm.getTranscriptForPlaylist(`tr-no-${Date.now()}`, {
    sourceLang: 'auto',
    translate: false,
    targetLang: 'en',
  });
  assert.equal(result.source, 'tier1-playlist');
  assert.deepEqual(calls, ['tier0', 'tier0.1', 'tier1']);
});
