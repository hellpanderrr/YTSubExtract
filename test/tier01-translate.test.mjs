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
let tier3Result = null;

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
      return tier3Result;
    },
    getVideoMetadata: async () => ({ title: '', languages: [] }),
  },
});

const { translationManager: tm } = await import('../src/background/translation-manager.mjs');

beforeEach(() => {
  calls = [];
  tier1Fails = false;
  tier3Result = null;
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

// Tier 1.7 (player coercion) CAN translate since 2026-10-03: it arms the
// source track carrying a translationLanguage, the player builds `tlang=` into
// its own timedtext request, and the content script accepts the capture only
// when the URL carried the requested tlang (src/utils/translated-capture.js).
// So a translated request now DOES use 1.7 — a hard reversal of the
// 2026-10-02 skip, forced by the real 2026-10-03 log where every API tier was
// bot-checked and the skip left translated batches with zero working tiers.
// Tier 2C still cannot translate (it never arms a track) and stays skipped.
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
    return [{ start: 0, duration: 1, text: 'translated text' }];
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

test('a translated request arms Tier 1.7 with the target tlang (and never 2C)', async () => {
  tier1Fails = true;
  const restore = patchPageLegTiers();
  const seenOptions = [];
  const origCoerce = tm._coercePlayerTranscript;
  tm._coercePlayerTranscript = async (videoId, options) => {
    seenOptions.push(options);
    return origCoerce(videoId, options);
  };
  try {
    const result = await tm.getTranscriptForPlaylist(`pl-tr-yes-${Date.now()}`, {
      sourceLang: 'auto',
      translate: true,
      targetLang: 'ru',
    });
    assert.ok(calls.includes('tier1.7'), '1.7 is now the translation-capable player tier');
    assert.ok(!calls.includes('tier2c'), '2C cannot arm a translationLanguage and must be skipped');
    assert.equal(seenOptions.length, 1);
    assert.equal(seenOptions[0].tlang, 'ru', '1.7 must be armed with the requested target language');
    assert.equal(result.source, 'tier1.7-player-coercion');
    assert.equal(result.result[0].text, 'translated text');
  } finally {
    restore();
  }
});

test('an untranslated request arms Tier 1.7 with NO tlang', async () => {
  tier1Fails = true;
  const restore = patchPageLegTiers();
  const seenOptions = [];
  const origCoerce = tm._coercePlayerTranscript;
  tm._coercePlayerTranscript = async (videoId, options) => {
    seenOptions.push(options);
    return origCoerce(videoId, options);
  };
  try {
    await tm.getTranscriptForPlaylist(`pl-tr-no-lang-${Date.now()}`, {
      sourceLang: 'auto',
      translate: false,
      targetLang: 'en',
    });
    assert.equal(seenOptions.length, 1);
    assert.equal(seenOptions[0].tlang, null, 'no translation requested → no tlang arming');
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

// Tier 2C never arms a translationLanguage, so for a translated request it can
// only capture source text. Once 1.7 started succeeding for translated
// requests, the test above short-circuits before 2C and no longer guards this
// skip (Pullfrog, PR #2, 2026-10-05: removing the gate left the suite green).
test('a translated request whose 1.7 attempt fails still skips 2C and reaches Auth', async () => {
  tier1Fails = true;
  const restore = patchPageLegTiers();
  tm._coercePlayerTranscript = async () => {
    calls.push('tier1.7');
    return null;
  };
  try {
    const result = await tm.getTranscriptForPlaylist(`pl-tr-2c-${Date.now()}`, {
      sourceLang: 'auto',
      translate: true,
      targetLang: 'ru',
    });
    assert.ok(calls.includes('tier1.7'));
    assert.ok(!calls.includes('tier2c'), '2C cannot translate and must be skipped');
    assert.ok(calls.includes('auth'));
    assert.equal(result.source, 'tier0.5-auth');
  } finally {
    restore();
  }
});

// Tier 3's engagement-panel fallback is always source language. A translated
// request must refuse a Tier 3 result that does not say it is translated, or
// source text ships under the target filename (Pullfrog, PR #2, 2026-10-05).
test('a translated request refuses an untranslated Tier 3 result', async () => {
  tier1Fails = true;
  tier3Result = { segments: [{ start: 0, end: 1, text: 'source text' }], language: 'en' };
  const restore = patchPageLegTiers();
  try {
    const result = await tm.getTranscriptForPlaylist(`pl-tr-t3-no-${Date.now()}`, {
      sourceLang: 'auto',
      translate: true,
      targetLang: 'ru',
    });
    assert.ok(calls.includes('tier3'));
    assert.notEqual(result.source, 'tier3-playlist', 'an untranslated Tier 3 result must not answer');
  } finally {
    restore();
  }
});

test('a translated request accepts a Tier 3 result marked isTranslated', async () => {
  tier1Fails = true;
  tier3Result = { segments: [{ start: 0, end: 1, text: 'перевод' }], language: 'ru', isTranslated: true };
  const result = await tm.getTranscriptForPlaylist(`pl-tr-t3-yes-${Date.now()}`, {
    sourceLang: 'auto',
    translate: true,
    targetLang: 'ru',
  });
  assert.equal(result.source, 'tier3-playlist');
  assert.equal(result.translated, true);
});
