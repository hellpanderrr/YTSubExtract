# Next

_Updated 2026-09-19 — branch playlist-download_

## State
Tier 0.5's DOM selectors fixed for `yt-lockup-view-model` (committed `3f12cf7`).
Suite green on public content: **8 passed, 2 skipped, exit 0**, with a real SRT
under `E2E_BATCH_EXPECT_SUCCESS=1`. The 2 skips are the LL tests.

## Open threads
- **LL verification is BLOCKED on login transfer, not on the extension.**
  Cookie-copy is a dead end (see Don't redo). Options, in order:
  1. Fix `e2e:login` to launch with the real keychain (drop Playwright's
     `--use-mock-keychain`/`--password-store=basic` via `ignoreDefaultArgs`)
     and sign in there — needs a headed run, Google may still flag automation.
  2. Run the suite against Chrome Dev (`channel: 'chrome-dev'`) pointed at a
     COPY of your signed-in `Profile 1` — same binary family that owns the
     session, so decryption should work. Needs a fixture flag; not implemented.
  3. Manual check: open the popup on `list=LL` in your logged-in Dev window
     (load unpacked `dist/`) and confirm the listing loads + a 1-video ZIP has
     a real subtitle.
- **Single-video flaked ~1 in 4 runs** (retry rescued it). Not investigated.

## Running / unfinished
- Nothing in background. Working `.e2e-profile/` removed; golden keeps the
  seeded (currently unusable-by-Chromium) cookies + Dev `Login Data`/`Web Data`.
- `e2e/fixtures.mjs` (uncommitted) now fail-fasts with LOGIN LOST + exit 2 when
  the golden carries a login Chromium cannot decrypt.

## Don't redo
- **Do NOT copy cookies between Chrome profiles to transfer a login.**
  Seeded cookies are DPAPI-`v10` blobs; Playwright's Chromium
  (`--use-mock-keychain`) cannot decrypt them and silently DELETES every
  encrypted row on first read (393KB → 20KB). Proven by seed → launch →
  `context.cookies()`: SID/SAPISID/LOGIN_INFO all MISSING. The session also
  doesn't transfer: accounts.google.com lands on the chooser.
- **Tier 0.5 DOM selectors:** fixed to `yt-lockup-view-model` (title in
  `yt-lockup-metadata-view-model h3`, duration in
  `yt-thumbnail-bottom-overlay-view-model`). Test a DOM tier by messaging the
  content script directly — "Loaded N videos" can come from the API fallback.
- **The system proxy must be up** (`ProxyEnable=0` breaks youtube.com with
  `ERR_CONNECTION_CLOSED` while curl works; do not trust curl).
- **A batch ZIP with only `_errors.txt` is a bug, not BotGuard** (auto→en fix).
- **No `--disable-software-rasterizer`** with `--disable-gpu`.
- `scripts/test-batch.js` and `scripts/login.js` are superseded by `e2e/`.
- Full history in `docs/LESSONS.md`.
