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

- **Playlist URLs whose videos lack accessible captions fail every extraction
  tier** (PoToken/BotGuard). Tier 0 (Android) → 0.1 (/next) → 3 (youtubei.js) →
  1 (InnerTube) → 1.5 (embed) → 2C (tab nav) → 0.5 Auth all reported failures for
  such videos; the pipeline is working, the content is simply unavailable. Batch
  tests should assert the mechanism (every selected video is accounted for, as a
  subtitle file or in `_errors.txt`), not that every download succeeds.