# Lessons

Dated one-line entries. Append-only — later entries supersede by date, they do
not delete earlier ones. When a lesson becomes enforced by a test/hook/guard,
append `✅ enforced by <path>` to that entry rather than removing it.

## 2026-09-18 — e2e harness for the MV3 extension

- **Extensions do not run in Playwright's headless shell.** `headless: true`
  alone selects `chromium-headless-shell`, where `--load-extension` is inert.
  Use full Chromium — `channel: 'chromium'` *with* `headless: true` — which does
  support extensions.

- **Launch the persistent context once per worker, not once per test.** Opening
  the same profile directory repeatedly causes intermittent Chromium exits with
  `STATUS_BREAKPOINT` (`0x80000003`) and profile contention. A worker-scoped
  fixture fixed repeated failures that per-test launches produced.

- **A worker-scoped fixture cannot depend on a test-scoped builtin.**
  `base.extend({ x: [fn, {scope:'worker'}] })` where `fn` destructures the
  builtin `context` fails with "worker fixture cannot depend on a test fixture
  defined in <builtin>". Derive worker fixtures from one another (`_browser`),
  then expose it to tests via a thin test-scoped alias.

- **The popup must be opened with the YouTube tab foregrounded.** The popup
  calls `chrome.tabs.query({active:true, currentWindow:true})`; opened as a tab it
  becomes the active tab and reports "Not a YouTube video or playlist page".
  Working sequence: `yt.bringToFront()` → open popup → `yt.bringToFront()` →
  `popup.reload()` so `init()` runs with YouTube active.

- **Chromium tears down the popup page ~400ms after a download starts**, which
  makes `download.saveAs()` in Playwright fail with "Target page, context or
  browser has been closed". Saving synchronously inside the `download` event
  handler worked once, but is flaky under repetition.

- **Do NOT set a CDP `Browser.setDownloadBehavior` download path for this
  extension.** With an explicit CDP download path, downloads fail with
  `Download interrupted: CRASH ()`. This was tried and reverted — do not
  re-derive it. The polling fallback (`chrome.downloads.search` from the service
  worker) is CDP-free but has not yet been proven reliable for single-video
  downloads. **UNRESOLVED as of 2026-09-18.**

- **Playwright gives extension downloads opaque UUID filenames** in its own
  artifacts directory, so the extension's declared filename is unavailable
  afterwards. Any matching must therefore be by content (magic bytes / header
  sniffing), not by name.

- **The popup's batch status string contains the word "failed" while running**
  (`Downloading... N/M (K failed)`). A naive `status.includes('failed')` error
  check false-positives. Match the actual error prefixes
  (`/^(Download failed|Failed to start download|Failed to load playlist)/`).

- **A stale `currentDownloadProgress` in `chrome.storage.local` disables the
  Download ZIP button.** A batch interrupted by a failed test leaves
  `status: 'running'` behind; the next popup open restores it. Tests must clear
  that key before running (see `resetDownloadProgress`).

- **`copy(document.cookie)` cannot capture YouTube auth cookies.** `__Secure-1PSID`,
  `SAPISID` and `SID` are HttpOnly and invisible to page JS, so the pre-existing
  `scripts/login.js` cookie-paste flow never actually signed the browser in.
  Manual sign-in into the dedicated profile is the reliable path.

- **The old `scripts/test-batch.js` used the wrong popup URL.** It navigates to
  `chrome-extension://<id>/popup/index.html`; the manifest declares
  `src/popup/index.html`. Treat that script as stale.

- **The e2e profile is copied from a golden profile each run, not reused in
  place.** Reusing one `.e2e-profile` made a warm profile fail where a fresh one
  passed. `npm run e2e:login` writes `.e2e-profile-golden`; the fixture deletes
  `.e2e-profile` and copies the golden one in at worker start (skipping
  `Singleton*`, `LOCK`, `*-journal`/`-wal`/`-shm`, `Crashpad/`, `*.log`), which
  keeps the fresh-profile case *and* preserves the login (headless re-login is
  not possible). Plain `rm -rf .e2e-profile` also throws away the login, which
  is why it only "sometimes" helped. The browser is worker-scoped, not per-test:
  `context.close()` does not synchronously release the profile's `SingletonLock`
  on Windows, so a per-test launch lands on a half-released profile.

- **A disabled system proxy makes youtube.com unreachable from the test
  browser, and it looks like a crash.** This wasted most of a session. With the
  proxy off, `page.goto('https://www.youtube.com/...')` fails with
  `net::ERR_CONNECTION_CLOSED` / `net::ERR_ABORTED` while `example.com` and
  `google.com` load fine — and the failure lands *after* fixture setup, so it
  reads as "browser died". Worse, `curl` kept working (Windows `ProxyEnable=0`
  makes curl go direct while Chromium still honours the configured proxy), so
  the network looked healthy from the shell. Diagnostic that settles it in one
  run: in a test body, `goto` youtube.com AND example.com. If example.com loads
  and youtube.com does not, it is the network path, not the harness — stop
  editing fixtures. Also verify the proxy is up before a suite run.

- **Chromium sometimes dies with a native startup crash, independent of the
  above.** Under load the browser process can exit ~2ms after launch with
  `exitCode=3221225477` (0xC0000005 ACCESS_VIOLATION) or `2147483651`
  (0x80000003 STATUS_BREAKPOINT), visible via `DEBUG=pw:browser`. This is a
  browser-process fault, not a test or product bug. Mitigations: keep the
  browser worker-scoped, retry the launch up to 4 times, and rely on
  `retries: 1`. Do NOT add `--disable-software-rasterizer`: with `--disable-gpu`
  it removes every raster path and made crashes more frequent, not fewer.
  Distinguish this from the proxy failure by the exit code — a `net::` error
  means network, an `exitCode=` line means a real crash.

- **"SRT button never enabled" is a third, unrelated failure.** The browser is
  healthy but the extension could not obtain caption tracks (BotGuard/poToken —
  see the playlist entry below). Check whether the language dropdown populated
  before suspecting the harness.

- **Playlist batch download silently failed for every video whose captions are
  not English.** The popup's playlist language dropdown defaults to "Auto (first
  available)", and the background converted that `'auto'` to `'en'` before
  calling `getSubtitles` (`translation-manager.mjs`, both the Tier 1 and Tier 1
  Fallback call sites). `getSubtitles` already resolves `'auto'` to
  `captionTracks[0]`, so the substitution made it hunt for a track the video does
  not have and fail with "Language en not found". Every API tier then reported a
  failure and the ZIP contained only `_errors.txt`. Single-video mode was
  unaffected because the popup resolves a concrete language first — which is why
  the *same video* downloaded fine one way and failed the other. Fixed by passing
  `sourceLang` through unchanged. Symptom to recognize: batch ZIP contains only
  `_errors.txt` while single-video works on the same video.
  ✅ enforced by `e2e/batch-download.spec.mjs` with `E2E_BATCH_EXPECT_SUCCESS=1`,
  which requires a real subtitle file per selected video (not just an
  accounted-for entry in `_errors.txt`).

- **Playlist URLs whose videos lack accessible captions fail every extraction
  tier** (PoToken/BotGuard). Tier 0 (Android) → 0.1 (/next) → 3 (youtubei.js) →
  1 (InnerTube) → 1.5 (embed) → 2C (tab nav) → 0.5 Auth all reported failures for
  such videos; the pipeline is working, the content is simply unavailable.
  **Caution (2026-09-18):** a "every video is accounted for" assertion is too
  weak — it passes just as happily when *all* videos fail, which is exactly how
  the `'auto'`→`'en'` bug above hid for a whole session (a green suite reported
  batch as working while every download failed). The default batch spec still
  asserts accounting so it survives caption-less playlists, but run it at least
  once with `E2E_BATCH_EXPECT_SUCCESS=1` on a captioned playlist before trusting
  batch at all.

- **Tier 0.5's DOM playlist selectors were stale and matched nothing.** YouTube
  now renders playlist rows as `yt-lockup-view-model` (title in
  `yt-lockup-metadata-view-model h3`, duration in
  `yt-thumbnail-bottom-overlay-view-model`); the old `ytd-playlist-video-renderer`
  elements are no longer emitted. A live playlist page returned **0** hits for
  every selector in the list, so the tier silently reported "No videos found in
  DOM" and the flow always fell through to the API path — which is why the
  breakage was invisible on public playlists (the API fallback covered for it)
  and only bit private ones like LL, where the API path is the one that fails.
  Symptom to recognize: a private playlist never loads, yet the same page's
  `ytInitialData` clearly contains videos. Fix: add the lockup selector (scoped
  to `ytd-browse[page-subtype="playlist"]` first) and parse `h3` /
  bottom-overlay for title and duration. Verify a DOM tier by sending its
  content-script message directly from the service worker
  (`chrome.tabs.sendMessage(tab.id, {type:'GET_PLAYLIST_VIDEOS_FROM_DOM', ...})`)
  — the popup's "Loaded N videos" can be satisfied by the API fallback and does
  not prove the DOM path ran at all.

- **Seeded login cookies do not survive a Playwright Chromium launch.**
  Chrome encrypts cookie values (DPAPI `v10` blobs) against a key in
  `Local State`, and Playwright launches Chromium with `--use-mock-keychain`
  (plus `--password-store=basic`). A Chromium launched that way cannot decrypt
  the seeded rows, so on first read it **silently deletes every encrypted
  cookie** (working `Cookies` shrank 393KB → 20KB; SID/SAPISID/LOGIN_INFO gone,
  only plausible-deniability rows like PREF/VISITOR_INFO survived) — and the
  failure surfaces much later as "The playlist does not exist" on LL. The
  session also does not transfer at all: accounts.google.com lands on the
  account chooser, so the cookies are dead weight outside their home profile.
  Consequences: (1) there is no cookie-copy login path — `e2e:login` must
  produce the session *inside* the profile Playwright will use, or the login
  must happen in a browser that shares the real keychain; (2) the fixture now
  fail-fasts: `prepareProfile` probes a throwaway copy and `process.exit(2)`
  with LOGIN LOST instead of running the suite signed out. Diagnostic that
  settles it in minutes: seed → launch → `context.cookies()` — if SID is
  MISSING, stop debugging the extension. Also note the schema trap that slowed
  this down: modern `cookies` has 20 columns with `encrypted_value` BETWEEN
  `value` and `path` (DDL: `... name, value, encrypted_value, path ...`), so a
  naive field walk mislabels the v10 blob as `path` and reports expiry wrong.
  And the Cookies file is SQLite, not text: search raw bytes or parse pages —
  a utf8 read silently mangles it.
  ✅ enforced by `e2e/fixtures.mjs` (`verifyCookiesSurvived`): when the golden
  profile holds a live auth row, a throwaway Chromium launch must still read
  SID/SAPISID/__Secure-1PSID or the worker exits 2 with LOGIN LOST.

- **RESOLVED 2026-09-19: drop the mock-keychain flags, log in inside the
  Playwright profile.** Both `e2e/login.mjs` and `e2e/fixtures.mjs` now pass
  `ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain',
  '--password-store=basic']`, so Chromium uses real DPAPI and cookies written
  by `e2e:login` decrypt on every later run (same key, same profile). Login
  also needs `--enable-automation` stripped +
  `--disable-blink-features=AutomationControlled`, or Google rejects the
  headed sign-in as "insecure browser". Cookie-copy from a real Chrome profile
  stays dead regardless: since Chrome 127 app-bound encryption binds the key
  to the source user-data dir, a copy into a different dir can never unwrap
  it (confirmed via web research + probes: `Secure Preferences` HMAC reset,
  phantom extension IDs, stale nested `Default/`, all red herrings — the SID
  cookie never survived). The golden profile must be re-seeded after this
  change (old mock-keychain cookies are undecryptable); wipe
  `.e2e-profile-golden/` and re-run `npm run e2e:login`.
  ✅ enforced by `e2e/login.mjs` + `e2e/fixtures.mjs` (`ignoreDefaultArgs`).
- **"First Liked video" is not a test fixture.** LL mixes Shorts with
  long-form and row 0 is whatever was liked most recently; several long-form
  rows carry ASR-only tracks that BotGuard answers with HTTP 200 + 0-byte
  bodies, failing every tier. The batch spec now walks rows with
  `.video-duration` ≥ 60s and takes the first yielding a real subtitle.
  Parse durations from the rows' `.video-duration` spans — the row text's
  leading index (`01 | Title | 23:26`) false-matches a naive time regex.