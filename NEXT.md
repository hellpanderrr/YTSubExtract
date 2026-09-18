# Next

_Updated 2026-09-18 — branch playlist-download_

## State
The e2e suite is green end-to-end: **8 passed, 1 skipped, exit 0** (verified
twice). The skipped spec is `private-playlist`, which needs a one-time login.
The blocker that consumed this session was **not** a code bug — see Open threads.

## Open threads
- **Log in to enable `private-playlist`.** Run `npm run e2e:login`, sign in, then
  confirm `private-playlist.spec.mjs` passes rather than skips. This writes
  `.e2e-profile-golden/`; every run copies it.
- **The system proxy must be running** before any suite run. If it is down,
  youtube.com fails with `net::ERR_CONNECTION_CLOSED` while other sites load —
  it looks like a crash but is the network. `curl` keeps working, so don't trust
  it as a check.
- **Single-video flaked once in ~4 runs** (a retry rescued it). Not investigated;
  `retries: 1` covers it. If it becomes frequent, check whether it is the native
  startup crash (`DEBUG=pw:browser`) or "SRT button never enabled" (BotGuard).
- **Batch ZIP verifies the mechanism, not subtitles.** The test playlist's videos
  lack accessible captions, so the ZIP contains only `_errors.txt`. To assert
  real subtitle output, point `E2E_BATCH_URL` at a playlist with captions and set
  `E2E_BATCH_EXPECT_SUCCESS=1`.

## Running / unfinished
- Nothing running in background. No stray Chromium processes hold the profile.
- `.e2e-profile-golden/` does **not** exist yet — login has never been completed,
  so `private-playlist` always skips.

## Don't redo
- **Do not chase "youtube.com fails but the browser is fine" as a harness bug.**
  That was a disabled system proxy. Diagnose in one step: `goto` youtube.com AND
  example.com in a test body. example.com OK + youtube.com failing = network.
- **Do not launch the persistent context per test.** `context.close()` does not
  synchronously release the profile's `SingletonLock` on Windows; the browser is
  deliberately worker-scoped.
- **Do not add `--disable-software-rasterizer`.** With `--disable-gpu` it removes
  every raster path and caused more crashes, not fewer.
- **The original `Download interrupted: CRASH` was a harness bug, now fixed.**
  `chrome.downloads.search` returns the whole profile's history including stale
  interrupted entries; `waitForFileDownloaded` now baselines on the max id at
  entry and only fails on downloads this run started.
- **`scripts/test-batch.js` and `scripts/login.js` are superseded** by `e2e/`.
- Full history of dead ends is in `docs/LESSONS.md`.
