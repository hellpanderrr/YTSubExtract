# Next

_Updated 2026-09-27 — branch playlist-download_

## State
WatchSeed ready-streak fix + null-probe reset + injectable `sleepMs`
(`translation-manager.mjs`), Tier 1.7 `arm+Nms` timing instrumentation
(`content.js`), new `test/watch-seed.test.mjs` — all **uncommitted**. Unit
**50/50**, build 3 bundles, both mutation-killed. A gated e2e run against
the real playlist from the original log confirmed both changes fire
correctly (streak proceeds after 2 ready probes; captioned tracklist
confirms in 953ms–9646ms with zero false-zero reads, captionless confirms
~1.0–1.3s) — but that same run surfaced `docs/ISSUES.md` **#1**: headless
got 0/6 real subtitles where a manual browser got 4/6 the same day.

## Open threads
- Commit the uncommitted work when asked (paths above + `CLAUDE.md`,
  `docs/LESSONS.md`, `docs/ISSUES.md`, this file).
- Implement the Tier 1.7 wait-level fast-abort using the new positive
  control: skip only the remaining wait on a confirmed-zero tracklist,
  window must clear ~10s (not a guess), Auth stays mandatory, log every
  firing. Data and reasoning in `docs/LESSONS.md` 2026-09-26/27.
- Tier 3 (youtubei.js) log suppression + historic-green check — never
  started (3rd item of the original 3-part plan).
- `docs/ISSUES.md` #1 — try `E2E_HEADED=1` against the same playlist to
  isolate automation-flag detection from proxy/cookie causes.

## Running / unfinished
Nothing running. `dist/` is rebuilt against the current **uncommitted**
source — reload the unpacked extension before any manual run.

## Don't redo
- WatchSeed's contract is a *usable player*, not an attested tracklist — the
  2-consecutive-`ready` streak returning early is correct, mirrors
  `readUntilStable`'s two-agreeing-reads shape.
- Falsy/nullish confusion is now a standing `CLAUDE.md` rule ("Coding
  gotchas") — recurred twice (`stable-read.js`, `watch-seed.test.mjs`).
- Playwright clears `test-results/` at run start — never redirect
  diagnostic output there; use the repo root (`*.log` is gitignored).
- Piping a possibly-long command through `tail -N` in the same invocation
  discards everything but the tail if it gets backgrounded — redirect to a
  file instead.
- `batch-download` e2e green ≠ real extraction (see `docs/ISSUES.md` #1) —
  don't treat a green run as proof subtitles actually downloaded.
