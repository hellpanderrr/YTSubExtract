# Next

_Updated 2026-09-25 — branch playlist-download_

## State
Backlog #5–#15 closed (`db4607f` + DS `0645794`, pushed through
`00d0bb1`). Full e2e **10/10** with `e2e/README.md`'s env example
(`E2E_BATCH_LIMIT=2` — example playlist has 2 videos); batch ZIP 2/2
through the live #11 queue. `npm test` 37/37, build + smoke green.
**Unpushed: `60c098b` + this close commit (2 ahead).**

## Open threads
- Push when asked; then manual proof from fresh `dist/`: playlist
  spinner/status, `/live/…` single-video, **Discard ZIP** (force a failed
  delivery), one no-captions video (tier-3 conversion, never unit-run).
- #12 residual: youtubei.js's fetch passthrough has no deadline (comment
  at `tier3-worker.mjs` ~40) — wrap or accept explicitly.
- Tier0.5 accepts partial playlist counts >0 (only 0 falls back to the
  API) — harden or leave (Reset re-fetches).
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
- Rebuild + reload before batch diagnosis; no CLEAR after failed ZIP
  delivery; ISOLATED can't read expandos (MAIN probe); adv `GLM` dead
  (use DS/muse).
- Gitignored: profiles, `*oauth*.json`, `YOUTUBE_POTOKEN_TRIALS.md`; IP
  `31.76.113.16` scrubbed. History: `docs/LESSONS.md`.
