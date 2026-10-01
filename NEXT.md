# Next

_Updated 2026-10-01 — branch playlist-download_

## State
The embed-iframe removal (`5016f65`) is pushed and was cleared of a suspected
regression: an A/B on this machine (old vs new manifest/rules/sniffer) showed
the same 0/6 on both, and the failing runs' service-worker logs show YouTube's
"Sign in to confirm you're not a bot" on every Tier 1 call. Extraction here is
dominated by that bot-check state, which flips run to run (1 of 6 headed runs
today reached 3+ subtitles).

Built and run locally this session (feature terms only; see `git status` for
what is committed): a weekly self-hosted canary —
`scripts/weekly-canary.mjs` (retry, pass-if-any-attempt, issue only after two
consecutive failures, comment-not-duplicate, close on pass; decision logic
pure + mutation-tested), `.github/workflows/weekly-canary.yml`, the
`E2E_GOLDEN_DIR` / `E2E_RESULT_FILE` hooks, and a CI test workflow
(`test.yml` + `engines >= 22.3`, suite verified on Node 22.3.0). Unit 81/81.

## Open threads
- `docs/ISSUES.md` #16 is the blocker for trusting the canary: as built it
  fails whenever YouTube bot-checks the runner IP. Add an INCONCLUSIVE
  outcome (pipe the Playwright output with `E2E_CONSOLE=1`, count
  "Sign in to confirm you’re not a bot" — curly apostrophe), keep it out of
  the failure streak, add a separate 'blocked for N weeks' signal, with tests.
- Neither workflow has run on GitHub. After the first push:
  `gh run list --workflow=test.yml`, then set `docs/ISSUES.md` #9 FIXED. The
  canary workflow needs a runner registered with labels
  `self-hosted, windows, ytsub-canary`, run interactively (headed Chromium),
  `E2E_GOLDEN_DIR` set outside the workspace, and repo variable
  `CANARY_PLAYLIST_URL`; the current playlist has 2 captionless videos, so
  `CANARY_MIN_OK=3` of 6, not 6 of 6.
- Untracked `scripts/canary-tier1.mjs` + `test/canary-classify.test.mjs` are
  the abandoned cookie-less probe (it only measured the bot-check). Delete
  both together, or keep as a diagnostic after adding `.reason` to its output.
- Backlog is `docs/ISSUES.md` #3-#16; suggested order is in the 2026-09-29
  review notes there (#3 translate mislabel, #4/#8 shared parse+format).

## Running / unfinished
Nothing running. The working tree's runtime files are at `HEAD` and `dist/`
is rebuilt from them. Reload the unpacked extension before any manual run.

## Don't redo
- The pre-/post-`5016f65` comparison: not a regression (see State). Don't
  re-bisect manifest/DNR/sniffer for the 0/6 — it is the bot-check.
- A cookie-less GitHub-hosted API canary: bot-checked (7/8 cold calls).
  Hosted + injected-session browser is untested (secret cookies, expiry,
  datacenter-IP flagging); self-hosted on this machine is the safer path.
- Never count pass/fail runs to decide if a change broke extraction: repeat
  the baseline first and read the failing run's failure reason
  (`docs/LESSONS.md` 2026-10-01).
- `actions/checkout` git-cleans ignored files — never keep the golden profile
  inside a CI workspace.
- Untracked `.psd`/analysis files in the repo root are not this work's;
  `YOUTUBE_POTOKEN_TRIALS.md` and `*oauth*.json` must never be committed.
