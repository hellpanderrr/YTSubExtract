// readUntilStable — read a live DOM snapshot until two consecutive counts
// agree, or a bounded number of reads is exhausted.
//
// Exists for Tier 0.5 playlist extraction (content.js): the one-shot DOM read
// accepted ANY partial count > 0 as complete (only 0 fell through to the API),
// so a slow — often proxy-latency — hydration yielded a silently short
// playlist. Reset re-fetches, but the popup gave no signal that the list was
// still growing.
//
// Contract:
// - First read empty → return immediately, no sleeps. The existing
//   ytInitialData → API → credentialed fallbacks already cover the
//   not-yet-hydrated case; a 0 here is not this helper's problem.
// - Otherwise re-read every `confirmMs` until two consecutive counts match.
// - Always returns after `maxReads` total reads (default 4 → worst case
//   ≈1.2s added; the settled-page case costs exactly one confirm interval).
// - Returns the LAST read — if hydration paused mid-way, we report the
//   freshest snapshot, not the first.
//
// `sleep` is injectable so tests run without fake timers.

export const DEFAULT_CONFIRM_MS = 400;
export const DEFAULT_MAX_READS = 4;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readUntilStable(
  read,
  { confirmMs = DEFAULT_CONFIRM_MS, maxReads = DEFAULT_MAX_READS, sleep = defaultSleep } = {}
) {
  let latest = await read();
  if (!latest || latest.length === 0) return latest;

  for (let attempt = 1; attempt < maxReads; attempt++) {
    await sleep(confirmMs);
    const next = await read();
    const prevCount = latest.length;
    latest = next;
    // Stable when two consecutive reads report the same count. An empty
    // snapshot mid-loop (page tearing) counts as changed, not as "done".
    if (next && next.length === prevCount) break;
  }
  return latest;
}
