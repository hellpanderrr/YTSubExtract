// Row-identity filtering for Tier 0.5 playlist DOM extraction (content.js).
//
// The selector sweep can harvest rows that are not part of the requested
// playlist: document-wide selectors may match containers left over from a
// previous playlist elsewhere in the SPA document, and readUntilStable only
// compares counts — an old list of 10 "looks stable" against a new list of 10.
// Seen 2026-10-02: the popup opened on a German-philosophy playlist returned
// the previous Deep Learning playlist's videos under the correct title, and
// the batch faithfully downloaded the wrong subtitles. (Which selector won
// that run was never logged — the mechanism is argued, not observed; the
// sweep logs added alongside this module settle it on the next occurrence.)
//
// Rows on a playlist page carry `&list=<playlistId>` in their watch href, so
// that parameter is the row's identity. A row is dropped only when it is
// POSITIVELY tagged with a different playlist — an absent list param is not
// evidence of wrongness (dropping untagged rows would silently shorten a
// correct playlist, the exact bug class stable-read.js exists to prevent):
// - No row tagged wrong → keep everything.
// - Rows tagged with another playlist → those rows dropped; if that empties
//   the result, the caller's empty-result fallbacks (ytInitialData → API →
//   credentialed fetch) take over, which is what we want instead of someone
//   else's subtitles.

/** Extract the `list` query param from a watch href, or null when absent. */
export function extractPlaylistListId(href) {
  const m = typeof href === 'string' ? href.match(/[?&]list=([^&#]+)/) : null;
  return m ? m[1] : null;
}

/**
 * Pick the row's identity-bearing anchor href: the first anchor whose href
 * carries a `list=` param, else the first anchor's href, else ''.
 *
 * Lockup rows render both a bare `/watch?v=X` (a tracking endpoint) and the
 * real `/watch?v=X&list=…` link; `querySelector` order is not guaranteed to
 * hit the list-bearing one, so selecting by presence of `list=` is what keeps
 * row identity reliable (verified 2026-10-02 on a live lockupViewModel).
 *
 * @param {Iterable<{getAttribute: (n: string) => string|null}>} anchors
 * @returns {string}
 */
export function pickRowHref(anchors) {
  let first = '';
  for (const a of anchors) {
    const href = a?.getAttribute?.('href') || '';
    if (!href) continue;
    if (extractPlaylistListId(href)) return href;
    if (!first) first = href;
  }
  return first;
}

/**
 * Drop rows positively tagged with a different playlist. Untagged rows pass.
 * @param {Array<{listId?: string|null}>} rows
 * @param {string} playlistId — the playlist the caller asked for
 * @returns {Array} the surviving rows (same shape; may be empty)
 */
export function filterPlaylistRows(rows, playlistId) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  return rows.filter((r) => r && (!r.listId || r.listId === playlistId));
}

/**
 * Try selectors in priority order and pick the winner.
 *
 * Preference is EVIDENTIAL before POSITIONAL: the first selector with at
 * least one positively-tagged row (listId === playlistId) wins outright —
 * even if an earlier selector produced surviving (untagged) rows. Positional
 * first-non-empty would let a stale untagged container that matches an early
 * document-wide selector beat the scoped selector behind it: untagged rows
 * pass the filter, the count stabilizes, and wrong rows ship again (the
 * incident, with the identity filter neutralized by absence of evidence).
 * Only when NO selector has a positively-tagged row does position decide
 * (first selector with any surviving rows) — renderers can drop the list
 * param, and there we have nothing better to go on.
 *
 * @param {string[]} selectors — priority order, most specific first
 * @param {(selector: string) => Array} getRows — extracts raw rows for one selector
 * @param {string} playlistId
 * @param {(selector: string, rawCount: number, keptCount: number) => void} [onAttempt]
 *   called once per selector that produced rows — diagnostics for the
 *   all-foreign path, which otherwise returns null with no trace of which
 *   selector grabbed what
 * @returns {{selector: string, rows: Array, rawCount: number, match: 'tagged'|'untagged'}|null}
 *   null when no selector produced any row of this playlist
 */
export function sweepPlaylistSelectors(selectors, getRows, playlistId, onAttempt) {
  let fallback = null; // first selector with surviving rows but no positive tag
  for (const selector of selectors) {
    const raw = getRows(selector);
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const kept = filterPlaylistRows(raw, playlistId);
    if (typeof onAttempt === 'function') onAttempt(selector, raw.length, kept.length);
    if (kept.length === 0) continue;
    if (kept.some((r) => r && r.listId === playlistId)) {
      return { selector, rows: kept, rawCount: raw.length, match: 'tagged' };
    }
    if (!fallback) fallback = { selector, rows: kept, rawCount: raw.length, match: 'untagged' };
  }
  return fallback;
}
