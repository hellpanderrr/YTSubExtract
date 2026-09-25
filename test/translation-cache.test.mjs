// Unit tests for TranslationManager cache integrity.
//   - #10: clearCache(videoId) must be scoped to that video — the per-video
//     definition was shadowed by a no-arg duplicate, so Reset wiped the whole
//     cache (including playlist:* batch entries).
//   - #5: tier3-native must not cache/return an empty [] as success.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers/chrome-mock.mjs';

const { state } = installChrome();
const { translationManager: tm } = await import(
  '../src/background/translation-manager.mjs'
);

beforeEach(() => {
  tm.cache.clear();
  tm._batchCancelled = false;
});

test('#10 clearCache(videoId) removes only that video\'s entries', () => {
  tm.cache.set('metadata:v1', { ok: 1 });
  tm.cache.set('transcript:v1:en:false:', { ok: 1 });
  tm.cache.set('metadata:v2', { ok: 1 });
  tm.cache.set('playlist:v2:en:false:', { ok: 1 });

  tm.clearCache('v1');

  assert.equal(tm.cache.has('metadata:v1'), false, 'metadata for v1 cleared');
  assert.equal(
    tm.cache.has('transcript:v1:en:false:'),
    false,
    'transcript for v1 cleared'
  );
  assert.equal(tm.cache.has('metadata:v2'), true, 'other video kept');
  assert.equal(
    tm.cache.has('playlist:v2:en:false:'),
    true,
    'playlist batch entry kept'
  );
});

test('#10 clearCache() with no argument still clears everything', () => {
  tm.cache.set('metadata:v1', { ok: 1 });
  tm.cache.set('playlist:v2:en:false:', { ok: 1 });

  tm.clearCache();

  assert.equal(tm.cache.size, 0, 'no-arg clears the whole cache');
});

test(
  '#5 tier3-native rejects empty JSON3 instead of caching [] as success',
  { timeout: 20000 },
  async () => {
    // Drive the REAL single-video chain with every network seam stubbed:
    //  - chrome.tabs must have an active YouTube tab (tier3-native queries it)
    //  - GET_BEST_CAPTION_URL answers with a caption URL
    //  - global fetch: only that caption URL answers — with JSON3 whose events
    //    parse but yield no usable segs (whitespace-only text is filtered);
    //    everything else (InnerTube, embed, youtubei.js, ...) rejects fast.
    state.tabs.push({
      id: 7,
      url: 'https://www.youtube.com/watch?v=vid_emptytest',
      active: true,
    });
    state.sendMessageHandler = (_tabId, message) =>
      message?.type === 'GET_BEST_CAPTION_URL'
        ? {
            success: true,
            url: 'https://www.youtube.com/api/timedtext?lang=en&v=vid_emptytest',
            logs: [],
          }
        : { success: false, error: 'not stubbed in test' };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('api/timedtext')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '   ' }] }],
            }),
        };
      }
      throw new Error('network disabled in test');
    };

    try {
      const cacheKey = 'transcript:vid_emptytest:en:false:';
      await assert.rejects(
        () =>
          tm._extractWithTranslationInternal(
            'vid_emptytest',
            { sourceLang: 'en', targetLang: 'ru', translate: false },
            cacheKey
          ),
        (err) => {
          assert.match(err.message, /All extraction tiers failed/);
          // Positive control: the chain really reached tier3-native and
          // failed THERE — not because some earlier stub broke the run.
          // (finalError in this function embeds the errors array in the
          // message; it has no .errors property.)
          assert.match(
            err.message,
            /"tier":"3-native","error":"No usable segments/,
            'tier3-native ran and failed with the empty-result error'
          );
          return true;
        }
      );
      assert.equal(
        tm.cache.has(cacheKey),
        false,
        'empty transcript must not be cached'
      );
    } finally {
      globalThis.fetch = origFetch;
      state.sendMessageHandler = null;
      state.tabs.length = 0;
    }
  }
);
