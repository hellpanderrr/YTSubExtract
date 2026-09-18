# Next

_Updated 2026-09-18 — branch playlist-download_

## State
Built a headless Playwright e2e suite for the extension (`e2e/`,
`playwright.config.mjs`). Harness, playlist-listing and smoke specs pass green
(verified exit 0). Single-video and batch download specs are written but the
download-capture path is **not yet reliable** — see Open threads.

## Open threads
- **Fix download capture for single-video specs.** Currently fails with
  `Download interrupted: CRASH ()`. Start from `e2e/helpers.mjs`
  (`waitForFileDownloaded` / `classifyDownload`) and the fixture in
  `e2e/fixtures.mjs`. Verify with:
  `E2E_VIDEO_URL="https://www.youtube.com/watch?v=KkOY9Arrg1Y" npx playwright test e2e/single-video.spec.mjs`
- **Re-verify batch ZIP spec** once download capture works:
  `E2E_BATCH_URL="https://www.youtube.com/playlist?list=PLQXk9_XDN67Ig46GNQt11mzHCfZ6JSjar" E2E_BATCH_LIMIT=2 npx playwright test e2e/batch-download.spec.mjs`
- **Verify the private-playlist spec against a real login.** It currently skips
  because `.e2e-profile/` is not signed in. Run `npm run e2e:login`, sign in,
  then confirm `private-playlist.spec.mjs` passes rather than skips.
- **Update `e2e/README.md`** if the download approach changes (it documents the
  current design and the two download paths).

## Running / unfinished
- Nothing running in background. `test-results/` and `.e2e-downloads/` hold
  stale output from failed runs; both are gitignored.
- `npm run e2e:login` has never been completed — the profile has 6 anonymous
  cookies and no auth cookies, so every login-gated spec skips.

## Don't redo
- **Do not add CDP `Browser.setDownloadBehavior` to the fixture.** It produces
  `Download interrupted: CRASH ()`; tried and reverted. Logged in
  `docs/LESSONS.md`.
- **Do not launch the persistent context per test.** It causes intermittent
  Chromium `STATUS_BREAKPOINT` crashes; the fixture is deliberately
  worker-scoped.
- **Do not assert that every playlist video downloads successfully.** Some
  videos have no reachable captions (PoToken/BotGuard) and fail all tiers by
  design. The batch spec asserts every selected video is *accounted for*
  (subtitle file or `_errors.txt`).
- **`scripts/test-batch.js` and `scripts/login.js` are superseded** by `e2e/`.
  They are stale (wrong popup URL; HttpOnly cookies make the paste flow a no-op).
- Do not run the full suite against the whole codebase's uncommitted files —
  only `e2e/` and `playwright.config.mjs` are this session's work.