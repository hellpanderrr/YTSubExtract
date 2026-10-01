# Next

_Updated 2026-10-02 — branch playlist-download_

## State
PR #2 (`playlist-download` -> `main`; merge-commit it, don't squash) is open
and has been through two rounds of both review bots (Pullfrog, CodeRabbit),
which run on their own when the PR changes; `test.yml` is green on GitHub.
Every bot finding is verified against the code before acting
(`docs/LESSONS.md` 2026-10-01/02). Round 1 found four real bugs; round 2
found one regression in my own fix (the e2e result-file write sat below
assertions) and the follow-up that translated requests must also skip Tiers
1.7/2C. Both are fixed in the working tree with mutation-killed tests
(`docs/ISSUES.md` #3 and #17). Check `git status` and
`git log origin/playlist-download..` for whether they are committed/pushed.

## Open threads
- After pushing: re-check PR #2 (`gh pr checks 2`, new bot reviews).
  Don't click Pullfrog's "Fix all" links without reading what they'd push.
- `docs/ISSUES.md` #16 blocks trusting the weekly canary: it fails whenever
  YouTube bot-checks the runner IP (5 of 6 headed runs on 2026-10-01). Add an
  INCONCLUSIVE outcome (capture SW console, match "Sign in to confirm
  you’re not a bot" — curly apostrophe), keep it out of the failure streak,
  add a 'blocked for N weeks' signal, with tests.
- Canary runner prerequisites (nothing registered yet): labels
  `self-hosted, windows, ytsub-canary`, run interactively (headed Chromium),
  `E2E_GOLDEN_DIR` outside the workspace, repo variable
  `CANARY_PLAYLIST_URL`, `CANARY_MIN_OK=3` of 6 for the current playlist.
- Still open (see the tracker): #18 (executor throw leaves a caller
  hanging), #10 (message forging; needs a short browser probe of
  `event.source` across worlds first), #8 (untested output formatters,
  duplicated timedtext parser), #6 (ZIP loss / download completion
  unobserved), #9 (no coverage/lint; release workflows on Node 18).

## Running / unfinished
Nothing running. `dist/` matches the current sources; reload the unpacked
extension before any manual run.

## Don't redo
- The pre/post-`5016f65` comparison: not a regression. The 0/6 runs are
  YouTube's bot-check (SW Tier 1 gets `LOGIN_REQUIRED`); don't bisect
  manifest/DNR/sniffer for it.
- A cookie-less or hosted-runner API canary: bot-checked. Self-hosted on
  this machine is the path; hosted + injected session is untested.
- Mutation harnesses need a timeout (`spawnSync` timeout + SIGKILL; a hang
  counts as killed): an infinite-loop mutant once left a mutant in a source
  file.
- Never count pass/fail runs to decide if a change broke extraction: repeat
  the baseline first and read why the failing runs failed.
- Don't put test counts in this file — they were wrong three times because
  untracked local files inflated the count above CI's.
- `actions/checkout` git-cleans ignored files — the golden profile must live
  outside the workspace on CI.
- Untracked `.psd`/analysis files in the repo root are not this work's;
  `YOUTUBE_POTOKEN_TRIALS.md` and `*oauth*.json` must never be committed.
