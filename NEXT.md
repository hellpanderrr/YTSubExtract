# Next

_Updated 2026-09-18 — branch playlist-download_

## State
The e2e suite is green: **8 passed, 1 skipped, exit 0** (verified at close),
including a batch ZIP with real subtitles under `E2E_BATCH_EXPECT_SUCCESS=1`.
A real product bug was found and fixed this session — playlist batch download
failed for every video whose captions are not English (see Open threads).

## Open threads
- **Verify private lists — needs your login.** Run `npm run e2e:login`, sign into
  YouTube, then run the private-playlist spec. The user asked specifically for
  Liked Videos (`list=LL`), checking both that the listing loads AND that a batch
  ZIP produces real subtitles:
  `E2E_PRIVATE_PLAYLIST_URL="https://www.youtube.com/playlist?list=LL" npx playwright test e2e/private-playlist.spec.mjs`
  Batch on LL is not yet covered by any spec — only listing is.
- **Single-video flaked ~1 in 4 runs** (retry rescued it). Not investigated.
  If frequent, check whether it is the native startup crash
  (`DEBUG=pw:browser`, look for `exitCode=`) or "SRT button never enabled".

## Running / unfinished
- Nothing running in background. No stray Chromium holds the profile.
- `.e2e-profile-golden/` does **not** exist — login has never been completed, so
  `private-playlist` always skips. Every run copies the golden dir to
  `.e2e-profile/`; without it the run is signed out.

## Don't redo
- **The system proxy must be running.** If it is down, youtube.com fails with
  `net::ERR_CONNECTION_CLOSED` while other sites load — it looks like a browser
  crash but is the network. `curl` keeps working, so don't trust it as a check.
  Diagnose in one step: `goto` youtube.com AND example.com in a test body.
- **Do not "fix" a batch ZIP containing only `_errors.txt` by blaming BotGuard.**
  That was a real bug (auto→en language substitution) that hid behind a too-lenient
  assertion for a whole session. Confirm with `E2E_BATCH_EXPECT_SUCCESS=1` first.
- **Do not launch the persistent context per test.** `context.close()` does not
  synchronously release the profile's `SingletonLock` on Windows; it is
  deliberately worker-scoped.
- **Do not add `--disable-software-rasterizer`** — with `--disable-gpu` it removes
  every raster path and caused more crashes, not fewer.
- **`scripts/test-batch.js` and `scripts/login.js` are superseded** by `e2e/`.
- Full dead-end history is in `docs/LESSONS.md`.
