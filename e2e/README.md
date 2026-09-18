# E2E test suite

Headless Playwright tests that load the built extension into a real Chromium and
drive its popup against live YouTube. Uses dedicated browser profiles, never
your everyday Chrome profile.

## One-time setup

```bash
npm run e2e:login     # opens a window; sign into YouTube, then press Enter
```

This writes a **golden profile** to `.e2e-profile-golden/`. Each test run copies
it to a throwaway `.e2e-profile/` so every run starts from the same clean,
signed-in state (a reused profile was observed to fail where a fresh copy
passed). Headless re-login is impossible, so the golden copy is the only way to
keep the session.

Google blocks sign-in from automated browsers, and YouTube's auth cookies
(`__Secure-1PSID`, `SAPISID`, `SID`) are HttpOnly, so neither scripted login nor
`document.cookie` can capture them. Signing in manually once is the only
reliable route.

Tests that need login **skip** (not fail) when no golden profile exists.

## Prerequisite: the system proxy must be up

The test browser reaches YouTube through your system proxy. If that proxy is
down or disabled, `www.youtube.com` fails with `net::ERR_CONNECTION_CLOSED`
while other sites load — which looks like a harness crash but is the network.
`curl` may still work (it can go direct while Chromium honours the configured
proxy), so do not trust curl here. Check the proxy is running before a suite run.

## Running

```bash
npm run e2e            # build, then run everything
npm run e2e:smoke      # just the harness self-test (no YouTube content needed)
npm run e2e:headed     # watch it run in a visible window
```

Individual files:

```bash
npx playwright test e2e/single-video.spec.mjs
npx playwright test e2e/batch-download.spec.mjs -g "ZIP"
```

## Configuration

Copy `.env.e2e.example` to `.env` or export these inline. Each spec skips cleanly
when its variable is unset.

| Variable | Used by | Notes |
|---|---|---|
| `E2E_PLAYLIST_URL` | playlist-listing | Any public playlist |
| `E2E_PRIVATE_PLAYLIST_URL` | private-playlist | Defaults to Liked Videos (`list=LL`); needs login |
| `E2E_VIDEO_URL` | single-video | A video with accessible captions |
| `E2E_BATCH_URL` | batch-download | Falls back to `E2E_PLAYLIST_URL` |
| `E2E_BATCH_LIMIT` | batch-download | How many videos to download (default 3) |
| `E2E_BATCH_EXPECT_SUCCESS` | batch-download | Set to `1` to require every video to succeed |
| `E2E_HEADED` | all | Set to `1` for a visible browser |

Example:

```bash
E2E_VIDEO_URL="https://www.youtube.com/watch?v=KkOY9Arrg1Y" \
E2E_PLAYLIST_URL="https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf" \
npm run e2e
```

## Specs

| File | Covers |
|---|---|
| `smoke.spec.mjs` | Harness self-test: extension loads, SW registers, popup reaches ready |
| `playlist-listing.spec.mjs` | Public playlist loads; select-all toggles rows |
| `private-playlist.spec.mjs` | Liked Videos (`LL`) via the credentialed-fetch fallback |
| `single-video.spec.mjs` | Language dropdown populates; SRT and VTT download with valid content |
| `batch-download.spec.mjs` | Batch ZIP lands with one file per video (or an error report) |

## How it works

- **Full Chromium, headless.** Extensions don't run in the headless *shell*, so
  the fixture uses `channel: 'chromium'` with `headless: true`. That combination
  does support extensions.
- **Persistent context, worker-scoped.** The browser launches once per worker and
  is reused across tests. Launching per test against the same profile directory
  causes intermittent Chromium `STATUS_BREAKPOINT` crashes.
- **Popup as a tab.** The popup calls `chrome.tabs.query({active: true})`, so it
  only sees a YouTube tab if that tab is in front. `openPopup()` foregrounds the
  YouTube tab, opens the popup, then reloads it so `init()` runs with YouTube
  active.
- **Two download paths.** Page-triggered downloads (single video) surface as
  Playwright `download` events and are saved with `download.saveAs()`. The batch
  ZIP is triggered by `chrome.downloads.download` from the service worker, which
  produces no page event — it's located through the extension's own
  `chrome.downloads` API instead (`waitForZipDownload`).
- **Storage reset.** The extension persists `currentDownloadProgress`; a stale
  `running` entry disables the Download ZIP button, so the batch spec clears it
  before each run.

## Known limitations

Some videos have no captions reachable by any tier (PoToken / BotGuard
restrictions). The batch spec therefore asserts the *mechanism* — every selected
video is accounted for, as a subtitle file or in `_errors.txt` — rather than
requiring every download to succeed. Point `E2E_BATCH_URL` at a playlist whose
videos have captions and set `E2E_BATCH_EXPECT_SUCCESS=1` for a strict check.

All videos also require at least one open YouTube tab for the content-script
tiers; the specs open one.

Artifacts (profiles, downloads, traces) are gitignored — the profile holds live
session cookies.