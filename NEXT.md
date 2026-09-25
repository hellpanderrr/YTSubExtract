# Next

_Updated 2026-09-25 — branch playlist-download_

## State
Fixed four popup defects: dead spinner (CSS keyed `.spinner.active`, JS
toggled `hidden` — every loading state was invisible), grey Download button
with false "Loaded" status (init now `finalizePlaylistLoad`: languages ∥
restore in parallel, `checkAndRestoreProgress` returns `statusOwned`), and
live/shorts/embed/youtu.be URLs rejected as "not a video page" (new pure
`src/utils/video-url.js` + MAIN-world player probe for ID-less URLs).
`npm test` 27/27, build green, smoke 3/3.
**Unpushed: `390d706` + `9a3d4a6` + this close commit (3 ahead).**

## Open threads
- Push when asked; then the user's manual proof: reload from fresh `dist/`,
  open a playlist (spinner visible, no grey-button dead zone), open a
  `/live/…` stream (must reach single-video mode).
- Review backlog (2026-09-25 full review; detail in `git log ff11b84`):
  #5 tier3-native caches `[]`, #7 TabNav interval leak, #10 duplicate
  `clearCache`, #11 onProgress TOCTOU, #12 fetch timeouts, #14 parked-ZIP
  no-dismiss, #15 cache-hit comment.
- Never started: e2e stop+pin spec, popup unit harness (would let the spinner
  be tested instead of asserted-by-review), circuit breaker.

## Running / unfinished
- Nothing running. Fresh build in `dist/` — reload the extension before any
  manual run (stale-build rule). Full e2e (`playlist-listing`,
  `single-video`) not run this session: needs the system proxy up.

## Don't redo
- **Spinner class contract**: `.spinner` is display:none; only
  `.spinner.active` renders. Grep both CSS and JS for a class name before
  assuming they match.
- **Never stamp a terminal status over a restored one** — `statusOwned` from
  `checkAndRestoreProgress` is the guard.
- **Never `git checkout -- <file>` on uncommitted work** — wiped session
  edits twice. Commit first, or reverse with an exact-string script.
- Rebuild + reload before ANY batch diagnosis (stale `dist/` saga).
- Never `CLEAR_DOWNLOAD_PROGRESS` after failed ZIP delivery; never read
  player expandos from ISOLATED (use MAIN-world probe).
- adv `GLM` alias is dead (now `cline-pass/glm-5.3-flash`); DS and muse
  resolve. Gitignored: profiles, `*oauth*.json`,
  `YOUTUBE_POTOKEN_TRIALS.md`; IP `31.76.113.16` scrubbed — never re-add.
  History: `docs/LESSONS.md`.
