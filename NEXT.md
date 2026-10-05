# Next

_Updated 2026-10-05 — branch playlist-download_

## State
1.1.5 is uploaded to the Web Store as a DRAFT (`uploadState: SUCCESS`, built from
`925e361`; the shipped code is identical to HEAD). PR #2 (`playlist-download` ->
`main`; merge-commit, don't squash) has had three bot rounds; what is left is
logged (#6, #23-#25). The close commit is local and unpushed.

## Open threads
- **Submit the 1.1.5 draft** in the Web Store dashboard (user action).
- **#23:** check Cloud project `ytsubextract-api` -> Audience says "In production"
  (needs home-page + privacy URLs, see #23). If still Testing, the new
  `REFRESH_TOKEN` dies ~2026-10-12. The token was pasted into a chat: revoke it at
  myaccount.google.com/permissions, make a new one, set it with
  `printf '%s' "$T" | gh secret set REFRESH_TOKEN`.
- **Unconfirmed:** that the live player honors `translationLanguage`. Proof is
  `Captured … tlang=<target>` in a real translated-batch log, or a headed
  `PROBE_TLANG=1 E2E_HEADED=1` run of `e2e/probe-tlang.spec.mjs` (first run
  `npx playwright install chromium`; the browser cache was pruned).
- **Pullfrog console:** add to Review PRs custom instructions "post each finding
  as its own comment, never only inside `<details>`"; delete its stale Learnings
  line about CLAUDE.md `event.source` drift (the doc is now correct).
- Open, in 1.1.5: #6 (ZIP delivery double-failure still says completed), #24
  (Stop during the seed waits it out), #25 (Tier 3). Also #22, #16, #18, #19.
- After any push: read both bots' newest reviews in full (CLAUDE.md has the commands).

## Running / unfinished
Nothing running. Reload the unpacked extension after every build.

## Don't redo
- E2E can't test #21 (reload carries no stale SPA rows; an empty Tier 0.5 falls
  through to a correct API list). Unit tests + mutation scripts cover it.
- `node scripts/mutate-playlist-rows.mjs` and `node scripts/mutate-translated-capture.mjs`
  must both exit 0.
- 0/6 headless e2e is expected under YouTube's bot-check (#1); confirm "Sign in to
  confirm you're not a bot" in the SW log before ruling out an extraction regression.
- Graft: only `init --agents claude --no-global --no-statusline`; never `npx graft`.
- Untracked root `.psd`/analysis files, `scripts/login.js`, `scripts/test-batch.js`
  and `.puppeteer-profile/` (a Chrome profile: never `git add` it) aren't this work's.
