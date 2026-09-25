# Next

_Updated 2026-09-25 — branch playlist-download_

## State
Three review rounds (adversarial subagent → DS → full-source subagent →
muse) resolved and shipped at v1.1.4: Stop button, click-time tab pin,
unified `_pageLegLock`, conditional ZIP clears, MAIN-world fast-abort.
`npm test` 21/21 (guards mutation-verified), smoke 3/3, build green.
**Unpushed: `390d706` (round-3 fixes) + this close commit.**

## Open threads
- Push `390d706` when asked; then the user's manual proof: reload from
  fresh `dist/`, switch tabs mid-batch (other tab must not move), Stop
  mid-batch (winds down, restores, silent partial ZIP).
- Review backlog (2026-09-25 full review; detail in `git log ff11b84`):
  #5 tier3-native caches `[]` as success, #7 TabNav interval leak,
  #10 duplicate `clearCache`, #11 onProgress TOCTOU, #12 fetch timeouts,
  #14 parked-ZIP no-dismiss, #15 cache-hit comment.
- Never started: e2e stop+pin spec, popup unit harness, circuit breaker.

## Running / unfinished
- Nothing running. Fresh build in `dist/` — user must reload the extension
  before any manual run (stale-build rule).

## Don't redo
- **Never `git checkout -- <file>` to undo a mutation** while it holds
  uncommitted work — wiped session edits twice. Commit first, or reverse
  with an exact-string script.
- Rebuild + reload before ANY batch diagnosis (stale `dist/` saga).
- Never `CLEAR_DOWNLOAD_PROGRESS` after failed ZIP delivery; never read
  player expandos from ISOLATED (use `_probeSettledNoTracks`); raced
  0-tracks never gates other tiers.
- adv `GLM` alias is dead (GLM left Cline's free tier — now
  `cline-pass/glm-5.3-flash`); DS and muse still resolve.
- Gitignored: profiles, `*oauth*.json`, `YOUTUBE_POTOKEN_TRIALS.md`.
  Full history: `docs/LESSONS.md`.
