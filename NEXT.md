# Next

_Updated 2026-09-18 — branch playlist-download_

## State
Tier 0.5's DOM playlist selectors were stale (YouTube now renders rows as
`yt-lockup-view-model`, not `ytd-playlist-video-renderer`), so the tier matched
0 elements and always fell through to the API path. Fixed + committed `3f12cf7`.
Suite green: **8 passed, 2 skipped, exit 0**, with a real SRT under
`E2E_BATCH_EXPECT_SUCCESS=1`. The 2 skips are the LL tests (no login yet).

## Open threads
- **Verify Liked Videos (LL) — waiting on login.** The user is running
  `npm run e2e:login` now. Once it reports signed in, run:
  `npx playwright test e2e/private-playlist.spec.mjs --reporter=line`
  Both tests must pass: listing (credentialed-fetch fallback) AND batch ZIP
  (requires a real subtitle by default; `E2E_LL_EXPECT_SUCCESS=0` relaxes it).
- The DOM fix is already proven without login: a direct Tier 0.5 message
  returned 2/2 videos with titles+durations on a live playlist. LL adds the
  signed-in credentialed path on top.
- **Single-video flaked ~1 in 4 runs** (retry rescued it). Not investigated.

## Running / unfinished
- Nothing in background.
- `.e2e-profile-golden/` does **not** exist until `e2e:login` succeeds; without
  it every run is signed out and the LL tests skip.

## Don't redo
- **Tier 0.5 DOM selectors:** the fix is `yt-lockup-view-model` (title in
  `yt-lockup-metadata-view-model h3`, duration in
  `yt-thumbnail-bottom-overlay-view-model`). To test a DOM tier, send its
  content-script message directly from the SW — the popup's "Loaded N videos"
  can come from the API fallback and does NOT prove the DOM path ran.
- **The system proxy must be up.** If down, youtube.com fails with
  `net::ERR_CONNECTION_CLOSED` while other sites load — looks like a crash but
  is the network. `curl` keeps working; don't trust it as a check.
- **Do not "fix" a batch ZIP containing only `_errors.txt` by blaming BotGuard.**
  A real bug (auto→en substitution) hid behind that for a session.
- **Do not add `--disable-software-rasterizer`** — with `--disable-gpu` it caused
  more crashes, not fewer.
- `scripts/test-batch.js` and `scripts/login.js` are superseded by `e2e/`.
- Full history in `docs/LESSONS.md`.
