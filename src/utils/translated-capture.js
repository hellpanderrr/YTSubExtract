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
// The rule is BIDIRECTIONAL — the capture's tlang must equal the request's,
// with "absent" a value on both sides:
// - Translation wanted: accept ONLY a capture whose URL carried exactly that
//   `tlang`. A source capture (no tlang, or a different one) is refused, so a
//   player that ignores the option yields an honest failure that falls through
//   to the translation-aware tiers.
// - No translation wanted: accept ONLY a capture with NO tlang. A leftover
//   translated capture for the same video (the per-video store outlives a
//   batch) would otherwise ship translated text under the source label — the
//   #3 mislabel in reverse. (The first version of this function returned true
//   for any capture here; caught in review 2026-10-05.)

/**
 * @param {string|null|undefined} captureTlang — tlang parsed off the captured URL
 * @param {string|null|undefined} wantTlang — target language the request asked for
 * @returns {boolean} whether this capture may be used as the request's answer
 */
export function captureMatchesRequest(captureTlang, wantTlang) {
  return (captureTlang || null) === (wantTlang || null);
}

/**
 * Store key for a captured transcript body.
 *
 * Source and translated captures of the same track share `lang` (a translated
 * request is `lang=en&tlang=ru`), so keying on `lang` alone made them collide:
 * last writer wins, and the player's toggle cycles can emit both. Translated
 * entries get `lang|tlang`; source entries keep the plain `lang` key so every
 * existing `videoMap.has(lang)` lookup is unchanged.
 *
 * @param {string|null|undefined} lang
 * @param {string|null|undefined} tlang
 * @returns {string}
 */
export function captureKey(lang, tlang) {
  const base = lang || 'unknown';
  return tlang ? `${base}|${tlang}` : base;
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
