// Unit tests for src/utils/playlist-rows.js (Tier 0.5 row-identity filter +
// selector sweep).
//
// Regression for the 2026-10-02 incident (ISSUES #21): popup opened on
// playlist B returned playlist A's rows (stable count, wrong videos) under
// playlist B's title, and the batch downloaded A's subtitles into a ZIP named
// after B.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractPlaylistListId,
  filterPlaylistRows,
  pickRowHref,
  sweepPlaylistSelectors
} from '../src/utils/playlist-rows.js';

const PL = 'PLs-uFzwfPADBJzpgZw6MhYmTPr8030LzN';
const OTHER = 'PLdeadbeefdeadbeefdeadbeefdeadbeef';

const row = (listId) => ({ videoId: 'x', title: 't', duration: '1:00', listId });

test('extractPlaylistListId reads the list param from typical playlist hrefs', () => {
  assert.equal(extractPlaylistListId(`/watch?v=abc123def45&list=${PL}&index=3`), PL);
  assert.equal(extractPlaylistListId(`/watch?list=${PL}&v=abc123def45`), PL);
  assert.equal(extractPlaylistListId(`/watch?v=abc123def45&list=${PL}`), PL);
});

test('extractPlaylistListId returns null when absent or on junk input', () => {
  assert.equal(extractPlaylistListId('/watch?v=abc123def45'), null);
  assert.equal(extractPlaylistListId(`/playlist?list=${PL}`), PL); // non-watch list param still counts
  assert.equal(extractPlaylistListId(null), null);
  assert.equal(extractPlaylistListId(undefined), null);
});

test('empty input passes through untouched', () => {
  assert.deepEqual(filterPlaylistRows([], PL), []);
  assert.deepEqual(filterPlaylistRows(null, PL), null);
});

test('rows tagged with a different playlist are dropped', () => {
  // The incident: stale DL rows harvested from a German playlist page.
  const stale = [row(OTHER), row(OTHER), row(OTHER)];
  assert.deepEqual(filterPlaylistRows(stale, PL), []);
});

test('UNTAGGED rows are kept even when other rows are tagged wrong', () => {
  // Absence of a list param is not evidence of wrongness — dropping untagged
  // rows would silently shorten a correct playlist (the stable-read bug class).
  const rows = [row(null), row(OTHER), row(null)];
  const kept = filterPlaylistRows(rows, PL);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((r) => r.listId === null));
});

test('rows with no list params anywhere are kept (renderer dropped the param)', () => {
  const rows = [row(null), row(null)];
  assert.deepEqual(filterPlaylistRows(rows, PL), rows);
});

test('mixed page: wrong dropped, right and untagged kept', () => {
  const rows = [row(OTHER), row(PL), row(null), row(PL)];
  const kept = filterPlaylistRows(rows, PL);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((r) => !r.listId || r.listId === PL));
});

// ── pickRowHref ───────────────────────────────────────────────────────────

const anchor = (href) => ({ getAttribute: (n) => (n === 'href' ? href : null) });

test('pickRowHref prefers the anchor that carries list= over a bare one', () => {
  // The live shape (2026-10-02): a lockup renders bare /watch AND /watch..&list=.
  const anchors = [
    anchor('/watch?v=fzterg20Qe8'),
    anchor(`/watch?v=fzterg20Qe8&list=${PL}&index=1&pp=iAQB`)
  ];
  assert.equal(pickRowHref(anchors), `/watch?v=fzterg20Qe8&list=${PL}&index=1&pp=iAQB`);
});

test('pickRowHref finds the list-bearing anchor regardless of DOM order', () => {
  const tagged = anchor(`/watch?v=x&list=${PL}`);
  const bare = anchor('/watch?v=x');
  assert.equal(pickRowHref([bare, tagged]), `/watch?v=x&list=${PL}`);
  assert.equal(pickRowHref([tagged, bare]), `/watch?v=x&list=${PL}`);
});

test('pickRowHref falls back to the first anchor when none carries list=', () => {
  assert.equal(pickRowHref([anchor('/watch?v=abc'), anchor('/watch?v=def')]), '/watch?v=abc');
});

test('pickRowHref returns "" on empty/junk input', () => {
  assert.equal(pickRowHref([]), '');
  assert.equal(pickRowHref([anchor(''), anchor(null)]), '');
  assert.equal(pickRowHref([{ getAttribute: () => null }]), '');
});

// ── sweepPlaylistSelectors ────────────────────────────────────────────────

test('sweep takes the first selector whose rows belong to this playlist', () => {
  const bySelector = {
    scoped: [row(PL), row(PL)],
    unscoped: [row(PL)]
  };
  const hit = sweepPlaylistSelectors(['scoped', 'unscoped'], (s) => bySelector[s], PL);
  assert.equal(hit.selector, 'scoped');
  assert.equal(hit.rows.length, 2);
  assert.equal(hit.rawCount, 2);
});

test('sweep skips a stale container that matches early and keeps sweeping', () => {
  // The incident shape: document-wide selector matches old rows first; the
  // scoped selector behind it has the real playlist. First-match-wins on raw
  // counts would have stopped at the stale one and reported 0 after filtering.
  const bySelector = {
    'stale-doc-wide': [row(OTHER), row(OTHER), row(OTHER)],
    'scoped-playlist': [row(PL), row(PL), row(PL)]
  };
  const hit = sweepPlaylistSelectors(
    ['stale-doc-wide', 'scoped-playlist'],
    (s) => bySelector[s],
    PL
  );
  assert.equal(hit.selector, 'scoped-playlist');
  assert.equal(hit.rows.length, 3);
  assert.equal(hit.rawCount, 3);
});

test('sweep returns null when every selector is empty', () => {
  assert.equal(sweepPlaylistSelectors(['a', 'b'], () => [], PL), null);
  assert.equal(sweepPlaylistSelectors(['a', 'b'], () => null, PL), null);
});

test('sweep returns null when every selector is all-foreign (fallback territory)', () => {
  const hit = sweepPlaylistSelectors(
    ['a', 'b'],
    (s) => (s === 'a' ? [row(OTHER)] : [row(OTHER), row(OTHER)]),
    PL
  );
  assert.equal(hit, null);
});

test('sweep treats untagged rows as belonging (they pass the filter)', () => {
  const hit = sweepPlaylistSelectors(['a'], () => [row(null)], PL);
  assert.equal(hit.selector, 'a');
  assert.equal(hit.rows.length, 1);
  assert.equal(hit.match, 'untagged');
});

test('POSITIVE tag beats an earlier untagged survivor (evidence > position)', () => {
  // The incident, neutralized by the untagged-keep rule: a stale container
  // whose rows carry no list param matches an early selector while the scoped
  // selector behind it has positively-tagged correct rows. Positional
  // first-non-empty would take the stale container.
  const bySelector = {
    'stale-untagged': [row(null), row(null), row(null)],
    'scoped-tagged': [row(PL), row(PL), row(PL)]
  };
  const hit = sweepPlaylistSelectors(
    ['stale-untagged', 'scoped-tagged'],
    (s) => bySelector[s],
    PL
  );
  assert.equal(hit.selector, 'scoped-tagged');
  assert.equal(hit.match, 'tagged');
});

test('first POSITIVE selector wins even when an earlier selector has survivors', () => {
  const bySelector = {
    untaggedEarly: [row(null)],
    taggedLater: [row(PL)],
    taggedLast: [row(PL), row(PL)]
  };
  const hit = sweepPlaylistSelectors(
    ['untaggedEarly', 'taggedLater', 'taggedLast'],
    (s) => bySelector[s],
    PL
  );
  assert.equal(hit.selector, 'taggedLater'); // first positive, not first survivor
});

test('with no positive tag anywhere, position decides (first survivor)', () => {
  const bySelector = {
    first: [row(null)],
    second: [row(null), row(null)]
  };
  const hit = sweepPlaylistSelectors(['first', 'second'], (s) => bySelector[s], PL);
  assert.equal(hit.selector, 'first');
  assert.equal(hit.match, 'untagged');
});

test('onAttempt reports raw/kept counts for every selector that produced rows', () => {
  const attempts = [];
  sweepPlaylistSelectors(
    ['foreign', 'empty', 'winner'],
    (s) => ({ foreign: [row(OTHER), row(OTHER)], empty: [], winner: [row(PL)] })[s],
    PL,
    (selector, raw, kept) => attempts.push([selector, raw, kept])
  );
  assert.deepEqual(attempts, [
    ['foreign', 2, 0],
    ['winner', 1, 1]
  ]);
});

// ── wiring: content.js must actually use the sweep (source-hygiene, same
//    pattern as manifest-hygiene / tier3-order) ────────────────────────────

test('content.js imports and calls the sweep with the requested playlist id', () => {
  const src = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*sweepPlaylistSelectors[^}]*\} from '\.\.\/utils\/playlist-rows\.js'/);
  assert.match(src, /sweepPlaylistSelectors\(selectors, extractRows, msg\.playlistId, onAttempt\)/);
  // Rows must carry identity or the filter has nothing to check, and the href
  // must be taken from an anchor that actually bears list= (pickRowHref).
  assert.match(src, /listId: extractPlaylistListId\(href\)/);
  assert.match(src, /pickRowHref\(watchAnchors\)/);
  // The ytInitialData fallback applies the same identity check.
  assert.match(src, /rowListId !== msg\.playlistId/);
});

test('translation-manager prints Tier 0.5 extraction logs on success', () => {
  const src = readFileSync(
    new URL('../src/background/translation-manager.mjs', import.meta.url),
    'utf8'
  );
  // Failure-only logs left the 2026-10-02 incident undiagnosable.
  assert.match(src, /\[Tier 0\.5 Playlist\] Logs:/);
});
