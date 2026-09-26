# Next

_Updated 2026-09-26 — branch playlist-download_

## State
Backlog #5–#15 closed (`db4607f` + DS `0645794`, pushed through
`00d0bb1`). This session closed the two residual threads: **#12
youtubei.js fetch deadline** (`e358078` — `fetchResponseWithTimeout`,
raw-Response variant, timer deliberately uncleared at header-arrival)
and **Tier0.5 partial-count blind spot** (`5bc9c29` — `readUntilStable`
re-reads until two counts agree; 400ms confirm, 4 reads max, empty
first read still short-circuits to the API fallbacks). Gates: unit
**45/45**, build 3 bundles, smoke 3/3, **full e2e 10/10** with
`e2e/README.md` env (proxy `127.0.0.1:7897` up, `E2E_BATCH_LIMIT=2`).
**Unpushed: everything after `00d0bb1` — run
`git log --oneline origin/playlist-download..HEAD` for the live list
(any count or sha written here is invalidated by this file's own
commits).**

## Open threads
- Push when asked; then manual proof from fresh `dist/`: playlist
  spinner/status, `/live/…` single-video, **Discard ZIP** (force a failed
  delivery), one no-captions video (tier-3 conversion, never unit-run).
- #12 residual is CLOSED — watch the 10s budget during manual proof: a
  legit slow player `base.js` through the proxy would now abort and tier 3
  falls through (param on `fetchResponseWithTimeout` is the lever).
- Tier0.5 known boundary (documented, not fixed): a playlist longer than
  one rendered batch still returns only DOM rows — no tier exceeds
  `maxResults`(50) anyway; scroll-continuations never auto-load.
- Never started: e2e stop+pin spec, popup unit harness, circuit breaker.

## Running / unfinished
- Nothing running. Rebuild + reload before manual runs. Full e2e needs
  `e2e/README.md`'s env example — a default run green-exits with 5 specs
  skipped (now flagged in CLAUDE.md).

## Don't redo
- Progress-write queue (main.mjs): append is synchronous (orders the last
  fire-and-forget onProgress before terminal); never nest queued calls;
  CLEAR is unqueued on purpose.
- Spinner contract (`.spinner.active` only); `statusOwned` guards
  restored statuses; never `git checkout -- <file>` on uncommitted work.
- `fetchResponseWithTimeout` timer must NOT be cleared at header-arrival
  (body read happens after return — mutation-tested); a `!next` truthiness
  check cannot detect an empty array in stable-read.
- Rebuild + reload before batch diagnosis; no CLEAR after failed ZIP
  delivery; ISOLATED can't read expandos (MAIN probe); adv `GLM` dead
  (use DS/muse).
- Gitignored: profiles, `*oauth*.json`, `YOUTUBE_POTOKEN_TRIALS.md`; IP
  `31.76.113.16` scrubbed. History: `docs/LESSONS.md`.