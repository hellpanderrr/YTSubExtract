# Next

_Updated 2026-10-07 — everything on `main`_

## State
- **PR #2 merged** (merge commit `6cd9bd4`); `playlist-download` branch deleted
  (local + remote). `main` is the only branch.
- **v1.1.5 released** through the new rail: GitHub release with the What's New
  body + zip (tag `v1.1.5` = the rail's run commit), CI green. The store draft
  is the `925e361` upload from 2026-10-05 (`src/` identical to the release tag).
- **Release rail**: `release.yml` (dispatch-only, main-only; version from
  manifest, notes from STORE_DESCRIPTION.md, one zip for both release and
  store-draft) + `announce.yml` (Discussions post, run only after the store is
  live). Retired: `build-release*.yml`, `publish-store*.yml`. Historical
  releases fixed: tags v1.1.0/v1.1.4 now point at the commits their assets were
  built from; all six releases have bodies; the v1.0.0 draft's asset was rebuilt
  (it had been clobbered with 1.1.2 code) and published; the duplicate v1.0.1
  draft was deleted; `v1.0.0`/`v1.1.0` tags added where missing.
- **Dependabot**: he 2.0.0 (named imports fix), dev-deps group (zip.cjs moved to
  fflate; pack.cjs adapted to node-rsa 2), fflate 0.8.3 (applied directly; PR #5
  closed as superseded — Dependabot kept force-pushing stale bases).

## Open threads
- **Submit the 1.1.5 draft** in the Web Store dashboard (user action), then run
  `Announce` (workflow_dispatch) once it shows live.
- **#23:** check Cloud project `ytsubextract-api` → Audience "In production"
  (needs homepage + privacy URLs). If still Testing, `REFRESH_TOKEN` dies
  ~2026-10-12. The token was pasted into a chat: revoke it at
  myaccount.google.com/permissions, make a new one, set with
  `printf '%s' "$T" | gh secret set REFRESH_TOKEN`.
- **Unconfirmed:** that the live player honors `translationLanguage`. Proof is
  `Captured … tlang=<target>` in a real translated-batch log, or a headed
  `PROBE_TLANG=1 E2E_HEADED=1` run of `e2e/probe-tlang.spec.mjs` (first run
  `npx playwright install chromium`; the browser cache was pruned).
- **Pullfrog console:** add to Review PRs custom instructions "post each finding
  as its own comment, never only inside `<details>`"; delete its stale Learnings
  line about CLAUDE.md `event.source` drift (the doc is now correct).
- Open issues: #6 (ZIP delivery double-failure still says completed), #24 (Stop
  during the seed waits it out), #25 (Tier 3), #22, #16, #18, #19. #13's
  double-drive note now matters more (the scripting fallback is load-bearing on
  translation batches).

## Running / unfinished
Nothing running. Reload the unpacked extension after every build.

## Don't redo
- `npm run bump X.Y.Z` is the only version bump (5 copies; refuses on
  disagreement). `STORE_DESCRIPTION.md` is tracked and is the single notes
  source — edit its top What's New block before releasing.
- Releases: dispatch `release.yml` from `main` only. Don't recreate the old
  free-text-version workflows; don't add `target_commitish: main` anywhere.
- `node scripts/mutate-playlist-rows.mjs` and `node scripts/mutate-translated-capture.mjs`
  must both exit 0.
- E2E can't test #21; unit tests + mutation scripts cover it.
- 0/6 headless e2e is expected under YouTube's bot-check (#1); confirm "Sign in to
  confirm you're not a bot" in the SW log before ruling out an extraction regression.
- Graft: only `init --agents claude --no-global --no-statusline`; never `npx graft`.
- Untracked root `.psd`/analysis files, `scripts/login.js`, `scripts/test-batch.js`,
  `icons/icon162.png` and `.puppeteer-profile/` (a Chrome profile: never `git add` it)
  aren't this work's.
