/**
 * Opt-in diagnostic probe (skips unless PROBE_TLANG=1): does the YouTube player honor
 * `setOption('captions', 'translationLanguage', ...)`?
 *
 * If yes, the player issues its own timedtext request with `&tlang=<lang>`
 * (BotGuard-solved, server-side translation), which the sniffer already
 * captures — that is the hybrid fix path for translated batches.
 *
 * Runs against a real watch page with the golden profile and prints every
 * timedtext request the page makes after we arm the player.
 */
import { test } from './fixtures.mjs';

const VIDEO_URL = process.env.PROBE_VIDEO_URL || 'https://www.youtube.com/watch?v=s2uXPz3wyCk';
const TARGET_LANG = process.env.PROBE_TARGET_LANG || 'ru';

test('probe: player translationLanguage issues a tlang timedtext request', async ({ context }) => {
  test.skip(!process.env.PROBE_TLANG, 'diagnostic probe — set PROBE_TLANG=1 to run');
  const page = await context.newPage();
  const timedtextRequests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('timedtext')) {
      timedtextRequests.push(url);
      console.log(`[probe:tlang] TIMEDTEXT REQUEST: ${url.slice(0, 220)}`);
    }
  });

  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Try to start playback — the player fetches its (attested) player response
  // when it actually loads the video; a paused page may still have an empty
  // tracklist. WatchSeed in the extension relies on the same effect.
  await page.evaluate(() => {
    try {
      const p = document.getElementById('movie_player');
      if (p && typeof p.playVideo === 'function') p.playVideo();
    } catch (e) {}
  }).catch(() => {});

  // Poll for tracks (attested response may take a while on a cold profile).
  await page.waitForFunction(() => {
    try {
      const p = document.getElementById('movie_player');
      const r = p?.getPlayerResponse?.();
      const t = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      return t.length > 0;
    } catch (e) { return false; }
  }, undefined, { timeout: 45000 }).catch(() => {
    console.log('[probe:tlang] no tracklist appeared in 45s (bot-check in headless?)');
  });

  // Only requests made AFTER arming count toward the verdict: navigation or a
  // sticky caption preference could already have requested a translation.
  const armedAt = timedtextRequests.length;
  const report = await page.evaluate(async ({ targetLang }) => {
    const player = document.getElementById('movie_player');
    if (!player) return { error: 'no movie_player' };
    const out = { hasLoadModule: typeof player.loadModule, hasSetOption: typeof player.setOption };

    const resp = player.getPlayerResponse?.();
    const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    out.tracks = tracks.map((t) => ({ lang: t.languageCode, kind: t.kind || null }));
    if (out.tracks.length === 0) return { ...out, error: 'no tracks in player response (bot-check?)' };

    const source = tracks.find((t) => t.kind === 'asr') || tracks[0];
    out.source = source.languageCode;

    try { player.loadModule('captions'); } catch (e) { out.loadModuleErr = String(e); }

    // Arm exactly the way production does (buildCaptionTrackOptions in
    // src/utils/translated-capture.js): the target rides INSIDE the track
    // object, set once. The player reads translationLanguage off the track
    // (`u.translationLanguage && (H.tlang = lM(u))`). An earlier version of
    // this probe set a separate 'translationLanguage' option and then a bare
    // track — the same clobber fixed in e598267 — so a "not honored" verdict
    // from it would have been false (Pullfrog, PR #2, 2026-10-05).
    const trackOpt = { languageCode: source.languageCode, translationLanguage: { languageCode: targetLang } };
    if (source.kind) trackOpt.kind = source.kind;
    try {
      player.setOption('captions', 'track', trackOpt);
      out.setTrack = 'ok';
    } catch (e) { out.setTrack = 'threw: ' + e.message; }

    // Nudge subtitles on.
    try {
      if (typeof player.toggleSubtitles === 'function') {
        player.toggleSubtitles(true);
        out.toggled = 'ok';
      }
    } catch (e) { out.toggled = 'threw: ' + e.message; }

    // Give the player a few seconds to issue the request(s).
    await new Promise((r) => setTimeout(r, 6000));

    // Read back what the player thinks is set.
    try { out.currentTrackOption = player.getOption('captions', 'track'); } catch (e) { out.currentTrackOption = 'threw'; }

    return out;
  }, { targetLang: TARGET_LANG });

  console.log('[probe:tlang] player report:', JSON.stringify(report, null, 2));
  console.log('[probe:tlang] timedtext requests seen:', timedtextRequests.length);
  for (const u of timedtextRequests) {
    const tlang = u.match(/[?&]tlang=([^&]+)/);
    const lang = u.match(/[?&]lang=([^&]+)/);
    console.log(`[probe:tlang]   lang=${lang?.[1]} tlang=${tlang?.[1] ?? '(none)'}`);
  }
  const afterArming = timedtextRequests.slice(armedAt);
  const honored = afterArming.some((u) => (u.match(/[?&]tlang=([^&]+)/) || [])[1] === TARGET_LANG);
  console.log(`[probe:tlang] VERDICT: ${honored
    ? `PLAYER HONORS translationLanguage (tlang=${TARGET_LANG} requested after arming)`
    : `NO tlang=${TARGET_LANG} request after arming — option not honored (or tracks blocked)`}`);
});
