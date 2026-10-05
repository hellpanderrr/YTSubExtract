/**
 * PROBE (temporary, not a committed test): does the YouTube player honor
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
  }, { timeout: 45000 }).catch(() => {
    console.log('[probe:tlang] no tracklist appeared in 45s (bot-check in headless?)');
  });

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

    // The candidate option (name from community docs; probe verifies it).
    try {
      player.setOption('captions', 'translationLanguage', { languageCode: targetLang });
      out.setTranslationLanguage = 'ok';
    } catch (e) { out.setTranslationLanguage = 'threw: ' + e.message; }

    try {
      player.setOption('captions', 'track', { languageCode: source.languageCode, kind: source.kind });
      out.setTrack = 'ok';
    } catch (e) { out.setTrack = 'threw: ' + e.message; }

    // Also try the raw translationLanguage format some builds use.
    try {
      player.setOption('captions', 'translationLanguage', targetLang);
      out.setTranslationLanguage2 = 'ok (bare string form)';
    } catch (e) { out.setTranslationLanguage2 = 'threw: ' + e.message; }

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
    try { out.currentTranslationOption = player.getOption('captions', 'translationLanguage'); } catch (e) { out.currentTranslationOption = 'threw'; }

    return out;
  }, { targetLang: TARGET_LANG });

  console.log('[probe:tlang] player report:', JSON.stringify(report, null, 2));
  console.log('[probe:tlang] timedtext requests seen:', timedtextRequests.length);
  for (const u of timedtextRequests) {
    const tlang = u.match(/[?&]tlang=([^&]+)/);
    const lang = u.match(/[?&]lang=([^&]+)/);
    console.log(`[probe:tlang]   lang=${lang?.[1]} tlang=${tlang?.[1] ?? '(none)'}`);
  }
  const anyTlang = timedtextRequests.some((u) => /[?&]tlang=/.test(u));
  console.log(`[probe:tlang] VERDICT: ${anyTlang ? 'PLAYER HONORS translationLanguage (tlang request seen)' : 'NO tlang request — option not honored (or tracks blocked)'}`);
});
