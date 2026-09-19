# Next

_Updated 2026-09-19 — branch playlist-download_

## State
LL verified end-to-end: **listing + batch ZIP green (2 passed, 42.7s)** with a
real SRT (`..._dQw4w9WgXcQ_auto.srt`). Login now uses real DPAPI (mock-keychain
flags dropped); full suite **9 passed, 1 failed** — the failure is the public
batch spec on an ASR-only video (BotGuard 0-byte bodies), not the harness.

## Open threads
- **Public batch spec flakes on ASR-only content** (`0VH1Lim8gL8` got 2/3 with
  `E2E_BATCH_EXPECT_SUCCESS=1`): same BotGuard class as LL row 0. Either point
  it at a std-caption playlist or apply the LL row-walker pattern.
- **Single-video ~1-in-4 flake** (retry rescued it). Not investigated.

## Running / unfinished
- Nothing in background. Golden profile holds the working login (gitignored).

## Don't redo
- **Do NOT copy cookies between Chrome profiles.** App-bound encryption
  (Chrome 127+) binds keys to the source user-data dir — copies never
  decrypt. Log in via `npm run e2e:login` (real-keychain flags); wipe
  `.e2e-profile-golden/` first if re-seeding after flag changes.
- **Google flags Playwright's login window** unless `--enable-automation` is
  stripped and `--disable-blink-features=AutomationControlled` is set.
- **Row 0 of LL is not a fixture** — walk `.video-duration` ≥ 60s rows.
- **A batch ZIP with only `_errors.txt` is a bug, not BotGuard** (auto→en fix);
  but ASR-only videos genuinely fail every tier (HTTP 200, 0 bytes).
- **The system proxy must be up** (`ProxyEnable=0` breaks youtube.com).
- **No `--disable-software-rasterizer`** with `--disable-gpu`.
- Full history in `docs/LESSONS.md`.
