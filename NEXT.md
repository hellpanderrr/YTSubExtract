# Next

_Updated 2026-09-26 — branch playlist-download_

## State
All code threads closed: backlog #5–#15 (`db4607f`+DS `0645794`, pushed
through `00d0bb1`), #12 youtubei.js deadline (`e358078`, raw-Response
variant), Tier0.5 partial-read (`5bc9c29`, `readUntilStable`). Verified
this close: unit **45/45**, build 3 bundles, smoke 3/3, **full e2e
10/10** (proxy up, README env). **Unpushed: everything after `00d0bb1`
— run `git log --oneline origin/playlist-download..HEAD` for the list.**

## Open threads
- Push when asked; then manual proof from fresh `dist/`: playlist
  spinner/status, `/live/…` single-video, **Discard ZIP** (force a failed
  delivery), one no-captions video (tier-3 conversion, never unit-run).
- #12 watch item: legit slow player `base.js` through the proxy would
  now abort at 10s and tier 3 falls through (`fetchResponseWithTimeout`
  param is the lever).
- Never started: e2e stop+pin spec, popup unit harness, circuit breaker.

## Running / unfinished
- Nothing running. Rebuild + reload before manual runs. Default `npm run
  e2e` green-exits with 5 specs skipped — needs the README env.

## Don't redo
- Progress-write queue (main.mjs): append sync (orders last onProgress
  before terminal); never nest queued calls; CLEAR unqueued on purpose.
- Spinner contract (`.spinner.active` only); `statusOwned` guards
  restored statuses; never `git checkout -- <file>` on uncommitted work.
- `fetchResponseWithTimeout`: never clear the timer at header-arrival;
  combine `init.signal` via `AbortSignal.any`; `!next` can't detect `[]`.
- Rebuild + reload before batch diagnosis; no CLEAR after failed ZIP
  delivery; ISOLATED can't read expandos (MAIN probe); adv `GLM` dead
  (use DS/muse).
- Gitignored: profiles, `*oauth*.json`, `YOUTUBE_POTOKEN_TRIALS.md`; IP
  `31.76.113.16` scrubbed. History: `docs/LESSONS.md`.
