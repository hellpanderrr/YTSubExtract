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
  buildCaptionTrackOptions,
  captureKey
} from '../src/utils/translated-capture.js';

test('no translation requested: a source capture (no tlang) is accepted', () => {
  assert.equal(captureMatchesRequest(null, null), true);
  assert.equal(captureMatchesRequest(null, undefined), true);
  assert.equal(captureMatchesRequest(undefined, null), true);
});

test('no translation requested: a TRANSLATED capture is refused (reverse mislabel)', () => {
  // A leftover tlang=ru capture for the same video must not ship as source
  // text. The first version of the rule accepted it (review 2026-10-05).
  assert.equal(captureMatchesRequest('ru', null), false);
  assert.equal(captureMatchesRequest('en', undefined), false);
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

// ── captureKey ────────────────────────────────────────────────────────────
// Source (lang=en) and translated (lang=en&tlang=ru) captures used to share
// the key 'en' — last writer won, so a source capture could erase the
// translated body the gate was waiting for.

test('captureKey: source captures keep the plain lang key', () => {
  assert.equal(captureKey('en', null), 'en');
  assert.equal(captureKey('en', undefined), 'en');
  assert.equal(captureKey('en', ''), 'en');
  assert.equal(captureKey(null, null), 'unknown');
});

test('captureKey: translated captures never collide with their source', () => {
  assert.equal(captureKey('en', 'ru'), 'en|ru');
  assert.notEqual(captureKey('en', 'ru'), captureKey('en', null));
  assert.notEqual(captureKey('en', 'ru'), captureKey('en', 'de'));
});

test('wiring: every capture store keys on captureKey and carries tlang', () => {
  const sniffer = readFileSync(new URL('../src/content/sniffer.js', import.meta.url), 'utf8');
  const content = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  assert.match(sniffer, /const key = captureKey\(lang, tlang\)/, 'sniffer global keys on lang+tlang');
  assert.match(sniffer, /tlang: tlang \|\| null\s*\n\s*\}\);/, 'sniffer global entry carries tlang');
  assert.match(content, /\.set\(captureKey\(lang, tlang\),/, 'content live store keys on lang+tlang');
  // Every read site, exactly. A '>= N' count could not detect a missing gate
  // (Pullfrog, PR #2, 2026-10-05); this list changes only on purpose.
  const gates = content.match(/captureMatchesRequest\([^()]*(?:\([^()]*\))?[^()]*\)/g) || [];
  assert.deepEqual(gates, [
    'captureMatchesRequest(videoMap.get(lang).tlang, null)', // GET_CAPTURED_TRANSCRIPT fast path
    'captureMatchesRequest(candidate.tlang, null)',          // GET_CAPTURED_TRANSCRIPT scan
    'captureMatchesRequest(entry.tlang, null)',              // POLL_TRANSCRIPT (2C)
    'captureMatchesRequest(entry.tlang, wantTlang)',         // 1.7 drainCache
    'captureMatchesRequest(tlang, wantTlang)',               // 1.7 live capture
  ]);
  // Three handlers read the store (GET_CAPTURED_TRANSCRIPT, POLL_TRANSCRIPT,
  // 1.7's drainCache); a fourth reader would need its own gate above.
  const readers = (content.match(/= capturedTranscripts\.get\(videoId\);/g) || []).length;
  assert.equal(readers, 3, 'a new capture-store reader must be added to the gate list');
});
