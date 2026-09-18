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

- **Playlist URLs whose videos lack accessible captions fail every extraction
  tier** (PoToken/BotGuard). Tier 0 (Android) → 0.1 (/next) → 3 (youtubei.js) →
  1 (InnerTube) → 1.5 (embed) → 2C (tab nav) → 0.5 Auth all reported failures for
  such videos; the pipeline is working, the content is simply unavailable. Batch
  tests should assert the mechanism (every selected video is accounted for, as a
  subtitle file or in `_errors.txt`), not that every download succeeds.