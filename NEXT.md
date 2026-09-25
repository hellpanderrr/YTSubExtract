# Next

_Updated 2026-09-25 — branch playlist-download_

## State
Backlog pass committed (`db4607f`, follow-ups in `0645794`): all seven
2026-09-25 review findings fixed — **#5** tier3-native throws on an empty
transcript instead of caching/returning `[]` (never cached; falls to the
next tier), **#7** TabNav double-`complete` interval leak (idempotent
`startPolling` + settle timer tracked through `cleanup`), **#10**
duplicate no-arg `clearCache` removed AND the scoped clear extended to
this video's `playlist:<id>:*` batch entries (playlist-mode Reset sends
no CLEAR_CACHE — that loop is the only per-video batch clear), **#11**
all progress writers serialized through one in-process queue
(`persistBatchProgress`/`atomicProgressUpdate` exported for tests), **#12**
`fetchTextWithTimeout` on the six raw fetches (headers + body, read only
on ok), **#14** "Discard ZIP" button when a parked ZIP won't deliver, **#15**
cache-hit comment corrected. `npm test` 37/37 (+10 new cases, every new
behavior mutation-checked), build green, smoke 3/3. A DS `/adv` review of
the pass was addressed same session.
**Unpushed: 7 ahead of origin (from `390d706` through this file's own
docs commit — live list: `git log --oneline origin/playlist-download..HEAD`).**

## Open threads
- Push when asked; then the user's manual proof from a fresh `dist/`:
  playlist open (spinner visible, no grey-button dead zone), `/live/…`
  stream reaches single-video mode, the new **Discard ZIP** button (force
  a ZIP delivery failure; clicking drops the parked key + record), and ONE
  no-captions video — that runs the tier-3 conversion
  (`JSON.parse(resp.text)`) no unit test executes.
- **#12 residual** (commented at `tier3-worker.mjs` ~line 40): youtubei.js's
  `fetch` passthrough has NO deadline — Tier 3 (the batch's primary tier)
  can still hang on a stalled socket while the heartbeat shows `running`.
  Wrap it with a Response-shaped bounded fetch, or accept explicitly.
- Never started: e2e stop+pin spec, popup unit harness (would make #14
  and the spinner testable), circuit breaker. Full e2e
  (`playlist-listing`, `single-video`) not run: needs the system proxy.

## Running / unfinished
- Nothing running. Fresh `dist/` includes the backlog pass — reload the
  extension before any manual run (stale-build rule).

## Don't redo
- **Spinner class contract**: `.spinner` is display:none; only
  `.spinner.active` renders. Grep both CSS and JS for a class name before
  assuming they match.
- **Never stamp a terminal status over a restored one** — `statusOwned`
  from `checkAndRestoreProgress` is the guard.
- **Progress-write queue properties** (main.mjs): the chain appends
  SYNCHRONOUSLY — the fire-and-forget last `onProgress` must enqueue
  before the terminal write, so never make `queueProgressWrite`
  async-at-entry; never queue a call that itself calls a queued fn
  (deadlock); `CLEAR_DOWNLOAD_PROGRESS` is deliberately unqueued (only
  runs after terminal, nothing enqueues after it).
- **Never `git checkout -- <file>` on uncommitted work** — wiped session
  edits twice. Commit first, or reverse with an exact-string script.
- Rebuild + reload before ANY batch diagnosis (stale `dist/` saga).
- Never `CLEAR_DOWNLOAD_PROGRESS` after failed ZIP delivery; never read
  player expandos from ISOLATED (use MAIN-world probe).
- adv `GLM` alias is dead (now `cline-pass/glm-5.3-flash`); DS and muse
  resolve. Gitignored: profiles, `*oauth*.json`,
  `YOUTUBE_POTOKEN_TRIALS.md`; IP `31.76.113.16` scrubbed — never re-add.
  History: `docs/LESSONS.md`.
