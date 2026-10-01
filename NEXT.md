# Next

_Updated 2026-10-01 — branch playlist-download_

## State
PR #2 (`playlist-download` -> `main`, 58 commits, merge-commit please, not
squash) is open. Both review bots ran on their own when it opened — Pullfrog
(via its GitHub app; its workflow file is dispatch-only) and CodeRabbit — and
`test.yml` is green on GitHub (Node 22). Every bot finding was verified
against the code before acting (`docs/LESSONS.md` 2026-10-01): 4 were real
bugs nobody had caught, ~3 of 16 were wrong or half-wrong.

A follow-up fix for the confirmed findings is prepared (`docs/ISSUES.md`
#17): continuation-page double-push, Tier 0/0.1 ignoring `translate`,
bounded `capturedTranscripts`, canary hardening (Playwright install, state
saved before `gh`), unused `puppeteer`, stale comments, plus tests for each
behaviour change (mutation-killed). Unit 96/96, build clean, smoke 3/3. Check
`git status` and `git log origin/playlist-download..` before assuming it has
been committed or pushed.

## Open threads
- After pushing the fix: re-check PR #2 (`gh pr checks 2`, new bot reviews).
  Don't click Pullfrog's "Fix all" links without reading what they'd push.
- `docs/ISSUES.md` #16 blocks trusting the weekly canary: it fails whenever
  YouTube bot-checks the runner IP (5 of 6 headed runs on 2026-10-01). Add an
  INCONCLUSIVE outcome (capture SW console, match "Sign in to confirm
  you’re not a bot" with the curly apostrophe), keep it out of the failure
  streak, add a 'blocked for N weeks' signal, with tests.
- Canary runner prerequisites (nothing registered yet): labels
  `self-hosted, windows, ytsub-canary`, run interactively (headed Chromium),
  `E2E_GOLDEN_DIR` outside the workspace, repo variable
  `CANARY_PLAYLIST_URL`, `CANARY_MIN_OK=3` of 6 for the current playlist.
- Still open from the review: #3 (Tier 1.7/2C ignore `translate`), #18
  (executor throw leaves a caller hanging), #10 (message forging; needs a
  short browser probe of `event.source` across worlds first), #8 (untested
  output formatters, duplicated timedtext parser), #6 (ZIP loss / download
  completion unobserved).
- Untracked `scripts/canary-tier1.mjs` + `test/canary-classify.test.mjs`
  are the abandoned cookie-less probe: delete both together.

## Running / unfinished
Nothing running. `dist/` matches the current sources; reload the unpacked
extension before any manual run.

## Don't redo
- The pre/post-`5016f65` comparison: not a regression. The 0/6 runs are
  YouTube's bot-check (SW Tier 1 gets `LOGIN_REQUIRED`); don't bisect
  manifest/DNR/sniffer for it.
- A cookie-less or hosted-runner API canary: bot-checked. Self-hosted on
  this machine is the path; hosted + injected session is untested.
- Mutation harnesses need a timeout (`spawnSync` timeout + SIGKILL, hang =
  killed): an infinite-loop mutant once left a mutant in a source file.
- Never count pass/fail runs to decide if a change broke extraction: repeat
  the baseline first and read why the failing runs failed.
- `actions/checkout` git-cleans ignored files — the golden profile must live
  outside the workspace on CI.
- Untracked `.psd`/analysis files in the repo root are not this work's;
  `YOUTUBE_POTOKEN_TRIALS.md` and `*oauth*.json` must never be committed.
