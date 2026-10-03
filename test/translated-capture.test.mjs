// Unit tests for src/utils/translated-capture.js — the acceptance rule that
// makes arming Tier 1.7 for translated requests safe (ISSUES #3).
//
// The rule: a translated request accepts a player capture ONLY when the
// captured URL carried exactly the requested tlang. A player that ignores
// `translationLanguage` produces a source capture (no tlang) — that must be
// refused so the request falls through to the translation-aware tiers instead
// of shipping source text under a target-language filename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureMatchesRequest } from '../src/utils/translated-capture.js';

test('no translation requested: any capture is acceptable', () => {
  assert.equal(captureMatchesRequest(null, null), true);
  assert.equal(captureMatchesRequest(null, undefined), true);
  assert.equal(captureMatchesRequest('ru', null), true);
  assert.equal(captureMatchesRequest('en', undefined), true);
});

test('translation requested: only the exact requested tlang is accepted', () => {
  assert.equal(captureMatchesRequest('ru', 'ru'), true);
});

test('translation requested: a SOURCE capture (no tlang) is refused', () => {
  // The incident shape: player ignored translationLanguage, fetched the
  // source track. Accepting this is the #3 mislabel.
  assert.equal(captureMatchesRequest(null, 'ru'), false);
  assert.equal(captureMatchesRequest(undefined, 'ru'), false);
});

test('translation requested: a different tlang is refused', () => {
  assert.equal(captureMatchesRequest('de', 'ru'), false);
  assert.equal(captureMatchesRequest('en', 'ru'), false);
});

test('empty-string tlang is treated as absent, not as a match', () => {
  assert.equal(captureMatchesRequest('', 'ru'), false);
  assert.equal(captureMatchesRequest('', null), true);
});
