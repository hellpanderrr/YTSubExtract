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
let tier1Fails = false;

mock.module('../src/utils/youtube-caption-extractor.js', {
  namedExports: {
    getSubtitles: async () => {
      calls.push('tier1');
      if (tier1Fails) throw new Error('No captions found');
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
  tier1Fails = false;
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

// Tiers 1.7 (player coercion) and 2C (tab navigation) record whatever language
// the player arms and have no translation option, yet their results were
// cached as `translated: translate`. For a translated request they must be
// skipped so the translation-aware Tier 0.5 Auth fallback runs instead.
function patchPageLegTiers() {
  const orig = {
    embed: tm._extractFromEmbed,
    coerce: tm._coercePlayerTranscript,
    tabNav: tm._fetchTranscriptViaTabNav,
    auth: tm._fetchTranscriptAuth,
  };
  tm._extractFromEmbed = async () => {
    calls.push('tier1.5');
    return null;
  };
  tm._coercePlayerTranscript = async () => {
    calls.push('tier1.7');
    return [{ start: 0, duration: 1, text: 'source-language text' }];
  };
  tm._fetchTranscriptViaTabNav = async () => {
    calls.push('tier2c');
    return [{ start: 0, duration: 1, text: 'source-language text' }];
  };
  tm._fetchTranscriptAuth = async () => {
    calls.push('auth');
    return [{ start: 0, duration: 1, text: 'translated text' }];
  };
  return () => {
    tm._extractFromEmbed = orig.embed;
    tm._coercePlayerTranscript = orig.coerce;
    tm._fetchTranscriptViaTabNav = orig.tabNav;
    tm._fetchTranscriptAuth = orig.auth;
  };
}

test('a translated request never uses player capture (1.7 / 2C) and falls through to Auth', async () => {
  tier1Fails = true;
  const restore = patchPageLegTiers();
  try {
    const result = await tm.getTranscriptForPlaylist(`pl-tr-yes-${Date.now()}`, {
      sourceLang: 'auto',
      translate: true,
      targetLang: 'ru',
    });
    assert.ok(!calls.includes('tier1.7'), '1.7 cannot translate and must be skipped');
    assert.ok(!calls.includes('tier2c'), '2C cannot translate and must be skipped');
    assert.ok(calls.includes('auth'));
    assert.equal(result.source, 'tier0.5-auth');
    assert.equal(result.result[0].text, 'translated text');
  } finally {
    restore();
  }
});

test('control: an untranslated request still uses player capture (1.7) before Auth', async () => {
  tier1Fails = true;
  const restore = patchPageLegTiers();
  try {
    const result = await tm.getTranscriptForPlaylist(`pl-tr-no-${Date.now()}`, {
      sourceLang: 'auto',
      translate: false,
      targetLang: 'en',
    });
    assert.ok(calls.includes('tier1.7'), 'player capture must remain available untranslated');
    assert.ok(!calls.includes('auth'), '1.7 succeeded, so Auth never runs');
    assert.equal(result.source, 'tier1.7-player-coercion');
  } finally {
    restore();
  }
});
