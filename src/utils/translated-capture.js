// Acceptance rule for player-captured transcripts on translated requests.
//
// Tier 1.7 (player coercion) arms the real player and the sniffer captures the
// timedtext response the player fetches. Before 2026-10-03 a translated batch
// skipped this tier entirely ("player capture cannot translate", ISSUES #3):
// the player fetched the SOURCE track, and accepting it under a target-language
// label shipped untranslated text in a `_ru.srt` (the #3 mislabel).
//
// The player's own source shows translation is a field on the track object:
// `setOption('captions','track', { languageCode, translationLanguage: { languageCode } })`
// makes it build `tlang=<that code>` into its timedtext request (player JS:
// `u.translationLanguage && (H.tlang = g.lM(u))`, `lM = u => u.translationLanguage ?
// u.translationLanguage.languageCode : u.languageCode`). The sniffer already
// parses `tlang` off the captured URL, so the capture itself carries the proof:
//
// - No translation wanted (`wantTlang` empty): any capture is acceptable —
//   source track requested, source track received.
// - Translation wanted: accept ONLY a capture whose URL carried exactly that
//   `tlang`. A source capture (no tlang, or a different one) is refused, so a
//   player that ignores the option yields an honest failure that falls through
//   to the translation-aware tiers — never mislabeled output. This is the
//   property that makes arming 1.7 for translated requests safe to ship.

/**
 * @param {string|null|undefined} captureTlang — tlang parsed off the captured URL
 * @param {string|null|undefined} wantTlang — target language the request asked for
 * @returns {boolean} whether this capture may be used as the request's answer
 */
export function captureMatchesRequest(captureTlang, wantTlang) {
  if (!wantTlang) return true;
  return captureTlang === wantTlang;
}

/**
 * The `captions`/`track` options to try when arming the player, in order.
 *
 * Both entries MUST carry the same translationLanguage when one is wanted:
 * the driver tries them in sequence and the LAST successful setOption wins,
 * so a bare fallback after a translated one silently strips the translation
 * (that exact clobber shipped once — every capture came back `tlang=none`
 * and the acceptance gate refused them, 2026-10-03 19:0x log).
 *
 * Two shapes because player builds differ on whether an explicit
 * `kind: undefined` is accepted; `bare` is the minimal object.
 *
 * @param {{languageCode: string, kind?: string|null}} pick
 * @param {string|null|undefined} wantTlang
 * @returns {Array<object>} options for setOption('captions','track', ...)
 */
export function buildCaptionTrackOptions(pick, wantTlang) {
  const tlang = wantTlang ? { translationLanguage: { languageCode: wantTlang } } : {};
  const rich = { languageCode: pick.languageCode, ...tlang };
  if (pick.kind) rich.kind = pick.kind;
  const bare = { languageCode: pick.languageCode };
  if (wantTlang) bare.translationLanguage = { languageCode: wantTlang };
  return [rich, bare];
}
