# Next

_Updated 2026-10-02 — branch playlist-download_

## State
PR #2 (`playlist-download` -> `main`; merge-commit, don't squash) has had four
rounds of both review bots; round 4 found no critical issues. Verified findings
are fixed and logged (`docs/ISSUES.md` #17); translated requests skip Tiers
0.1/1.7/2C and the seed. `test.yml` is green. Graft is wired at project level;
the user's statusline was verified untouched. `git log origin/playlist-download..`
shows anything unpushed.

## Open threads
- **Decide `.mcp.json`** (#20): `graft mcp` (recommended; no remote exec), pin
  0.21.1 after a sandbox check, or leave. The user's 0.17.0 isn't on npm.
- #16 blocks trusting the weekly canary (it measures YouTube's bot-check): add an
  INCONCLUSIVE outcome matching "Sign in to confirm you’re not a bot" (curly
  apostrophe). No runner is registered yet.
- #19: make ONE real `lang=en&tlang=en` request before building a guard.
- Also open: #18, #10 (browser probe of `event.source` first), #8, #6, #9.
- After any push, read the bots' next round (`gh pr checks 2`) before moving on.

## Running / unfinished
Nothing running. Reload the unpacked extension; restart Claude Code for graft's MCP.

## Don't redo
- 0/6 e2e runs are YouTube's bot-check, not a regression from `5016f65`; don't
  bisect for them. Cookie-less/hosted canaries are bot-checked; use self-hosted.
- Graft: only `init --agents claude --no-global --no-statusline` with
  `DO_NOT_TRACK=1`; never `npx graft` (unrelated package). Leave the baked path in
  `graft-hooks.cjs` (removing it doubled hook latency, 478 -> 1003 ms).
- Mutation harnesses need a timeout. No test counts in this file.
- Keep the golden profile outside the CI workspace (`E2E_GOLDEN_DIR`).
- Root `.psd`/analysis files aren't this work's; never commit
  `YOUTUBE_POTOKEN_TRIALS.md` or `*oauth*.json`.
