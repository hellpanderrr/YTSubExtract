# Next

_Updated 2026-10-05 — branch playlist-download_

## State
PR #2 (`playlist-download` -> `main`; merge-commit, don't squash) carries the
1.1.5 release: playlist-identity fix (#21), Tier 1.7 translating via the
player's `translationLanguage` (#3), youtubei.js 18. Translated requests skip
Tiers 0.1 and 2C only; 1.7 arms `tlang` and the watch-page seed runs for them.
Every bot finding so far is fixed or logged. Store already has 1.1.4.

## Open threads
- **Publish:** run `publish_store_draft.yml` on this branch (uploads with
  `publish: false`), check the dashboard draft, then publish. Needs the user's go.
- **Unconfirmed:** that the live player honors `translationLanguage`. Proof is
  `Captured … tlang=<target>` in a real translated batch log, or a headed
  `PROBE_TLANG=1` run of `e2e/probe-tlang.spec.mjs`.
- After any push: read both bots (`gh pr checks 2`, then the PR comments).
- Open, not release-blocking: #6 (ZIP lost when both delivery paths fail), #22
  (first-srt latency), #16, #18, #19.

## Running / unfinished
Nothing running. Reload the unpacked extension after every build.

## Don't redo
- E2E can't test #21: a reload can't carry stale SPA rows, and an empty Tier
  0.5 falls through to a correct API list. Unit tests + mutation scripts cover it.
- Run `node scripts/mutate-playlist-rows.mjs` and
  `node scripts/mutate-translated-capture.mjs`; both must exit 0.
- 0/6 headless e2e results are YouTube's bot-check, not a regression.
- Graft: only `init --agents claude --no-global --no-statusline`; never `npx graft`.
- Root `.psd`/analysis files and `scripts/login.js`, `scripts/test-batch.js`
  aren't this work's; leave them untracked.
