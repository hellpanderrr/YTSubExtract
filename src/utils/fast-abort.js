// runFastAbort — decide whether Tier 1.7's outer wait should abort early on
// a confirmed-zero tracklist report.
//
// sniffer.js's own arm-level signal (videoId-matched, 2-poll
// settledZeroStreak >= 2) already reports "0 tracks" reliably and fast for
// genuinely captionless videos (~1.0-1.3s, see docs/LESSONS.md
// 2026-09-26/27) -- but the sample behind that number is small, so the zero
// report alone isn't trusted as the sole abort trigger. `windowMs` is a
// floor measured from `armedAt` (not from when the zero was first seen), so
// a genuinely slow captioned video -- observed up to 9646ms arm-to-tracklist
// in the same sample -- always gets that full window to report tracks > 0
// and override the abort, however quickly the zero itself arrived.
//
// `now`/`sleep` injectable so tests run without fake timers or real delay.

const defaultNow = () => performance.now();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runFastAbort({
  armedAt,
  windowMs,
  getTracklistCount,
  now = defaultNow,
  sleep = defaultSleep,
}) {
  const remaining = windowMs - (now() - armedAt);
  if (remaining > 0) await sleep(remaining);
  if (getTracklistCount() === 0) {
    return { fire: true, elapsedMs: Math.round(now() - armedAt) };
  }
  return { fire: false };
}
