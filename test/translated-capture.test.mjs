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
import { readFileSync } from 'node:fs';
import {
  captureMatchesRequest,
  buildCaptionTrackOptions
} from '../src/utils/translated-capture.js';

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

// ── buildCaptionTrackOptions ──────────────────────────────────────────────
// The 2026-10-03 tlang=none bug: the driver ran a bare follow-up setOption
// after the translated one, clobbering the translationLanguage. Every option
// the driver may try MUST carry the target.

test('every candidate option carries the translationLanguage when translating', () => {
  const opts = buildCaptionTrackOptions({ languageCode: 'en', kind: 'asr' }, 'ru');
  assert.ok(opts.length >= 2, 'rich + bare candidates');
  for (const o of opts) {
    assert.deepEqual(
      o.translationLanguage,
      { languageCode: 'ru' },
      `option ${JSON.stringify(o)} lost the translationLanguage`
    );
  }
});

test('no translation requested: no option carries a translationLanguage', () => {
  for (const o of buildCaptionTrackOptions({ languageCode: 'en', kind: 'asr' }, null)) {
    assert.equal(o.translationLanguage, undefined);
  }
  for (const o of buildCaptionTrackOptions({ languageCode: 'en' }, undefined)) {
    assert.equal(o.translationLanguage, undefined);
  }
});

test('the rich candidate carries kind; the bare candidate never does', () => {
  const [rich, bare] = buildCaptionTrackOptions({ languageCode: 'en', kind: 'asr' }, null);
  assert.equal(rich.kind, 'asr');
  assert.equal(bare.kind, undefined);
  assert.equal(bare.languageCode, 'en');
});

test('wiring: drivers must gate the bare setOption behind a thrown rich one', () => {
  // Source-hygiene (the drivers are browser code, not unit-importable).
  const sniffer = readFileSync(new URL('../src/content/sniffer.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/background/main.mjs', import.meta.url), 'utf8');
  assert.match(sniffer, /buildCaptionTrackOptions\(pick, wantTlang\)/, 'sniffer uses the helper');
  for (const [name, src] of [['sniffer.js', sniffer], ['main.mjs', main]]) {
    assert.match(
      src,
      /armed = true/,
      `${name}: the fallback setOption must be gated (armed flag), not unconditional`
    );
    assert.doesNotMatch(
      src,
      /try \{ player\.setOption\('captions', 'track', \{ languageCode: pick\.languageCode, kind: pick\.kind \|\| undefined \}\); \} catch \(e\) \{\}/,
      `${name}: the old unconditional bare setOption (clobber) must be gone`
    );
  }
});
