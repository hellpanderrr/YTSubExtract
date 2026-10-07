# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

- `npm run dev` — Start Vite dev server
- `npm run build` — Build all three bundles (main, content, sniffer)
- `npm run pack` — Build + create signed `.crx`
- `npm run zip` — Build + create `.zip` for Chrome Web Store upload
- `npm run clean` — Remove `dist/` and `builds/`

### Unit tests (node:test, no network, no browser)

- `npm test` — runs `test/*.test.mjs`: batch Stop state machine
  (`running→stopping→stopped`, finalize refusal, `err.wasStopped`, queued
  progress writes that can't clobber a Stop), tab pinning
  (`_resolvePageLegTab`, cancel checkpoints, restore, TabNav poll-interval
  leak), translation-cache integrity (scoped `clearCache`, tier3-native
  empty-transcript rejection), popup URL detection
  (`test/video-url.test.mjs`), the fetch-timeout helper (both the
  `{ok,status,text}` and raw-Response variants), `stable-read`
  (Tier 0.5 hydration stabilization), `seedWatchPage`'s ready-streak
  early-return (`test/watch-seed.test.mjs`), and Tier 1.7's wait-level
  fast-abort window math (`test/fast-abort.test.mjs`), manifest/DNR hygiene
  (`test/manifest-hygiene.test.mjs`), and the playlist
  tier-chain order (`test/tier3-order.test.mjs`) and translate gating (`test/tier01-translate.test.mjs`) — both need
  `--experimental-test-module-mocks`, supplied by `npm test`; also `playlist-extractor`, `android-translate`, `prune-map`, `weekly-canary`, `playlist-rows` (Tier 0.5 row identity: `list=` filter, positive-evidence sweep, `pickRowHref`) and `translated-capture` (bidirectional `tlang` gate, `captureKey`, no-clobber arming options) — all pure node. The last two have committed mutation harnesses: `node scripts/mutate-playlist-rows.mjs`, `node scripts/mutate-translated-capture.mjs` (exit 0 = every mutant killed). Background modules are
  imported for real with a `chrome.*` mock
  (`test/helpers/chrome-mock.mjs`) and `translationManager` network seams
  patched — no YouTube calls. Playwright specs stay in `e2e/`.
  Needs **Node >= 22.3** (`engines`; `mock.module` — floor verified on
  22.3.0). `.github/workflows/test.yml` runs `npm test` + `npm run build`
  on every push/PR; the four release workflows still build on Node 18 and
  do not run tests.

### E2E tests (Playwright, headless)

- `npm run e2e:login` — ONE-TIME: opens a window to sign into YouTube, writing a
  golden profile at `.e2e-profile-golden/` (each run copies it). Required for
  login-gated specs; they skip without it.
- `npm run e2e` — build, then run the whole suite. **Green ≠ full coverage**:
  `playlist-listing`, `single-video`, and `batch-download` `test.skip` unless
  `E2E_PLAYLIST_URL`/`E2E_VIDEO_URL` are set — read the ok/skip counts, not
  just the exit code (`e2e/README.md` has the env table; `E2E_BATCH_LIMIT`
  must not exceed the playlist's video count). **`batch-download` green also
  ≠ real extraction**: it asserts every video is accounted for (subtitle or
  `_errors.txt`), so a run where every video fails is still a pass. Confirmed
  2026-09-26: two runs against a real playlist got 0/6 real subtitles in
  headless (`403 Forbidden` / `net::ERR_CONNECTION_CLOSED` on caption
  fetches) where a manual browser got 4/6 the same day — see `docs/ISSUES.md`
  #1. Set `E2E_BATCH_EXPECT_SUCCESS=1` to make a run fail on this instead of
  passing silently.
- `npm run e2e:smoke` — harness self-test only (no YouTube content needed)
- `npm run e2e:headed` — run with a visible browser
- `E2E_GOLDEN_DIR` relocates the golden login profile outside the checkout — required on any CI runner, because `actions/checkout` runs `git clean -ffdx` and deletes ignored in-workspace files. `scripts/weekly-canary.mjs` + `.github/workflows/weekly-canary.yml` are the self-hosted weekly batch canary; its result is dominated by YouTube's bot-check state until `docs/ISSUES.md` #16 is built (`docs/LESSONS.md` 2026-10-01).

The test browser reaches YouTube through the system proxy — if that proxy is
down, youtube.com fails with `net::ERR_CONNECTION_CLOSED` (which looks like a
harness crash) while other sites load fine. Check the proxy before a run.

Specs live in `e2e/`; see `e2e/README.md` for env vars and per-spec coverage.
Harness gotchas and dead ends are logged in `docs/LESSONS.md`.

## Code navigation: use graft first

This repo is indexed by [graft](https://github.com/trailhq/Graft)
(`@nanonets/graft`; a global `graft` is on PATH). Before grepping or reading
whole files to find, understand, or scope a change in `src/`, `test/` or
`e2e/`, ask the graph — it returns exact `file:line` and only the relevant
code:

- `graft ask "<question>" --source` — where does X live / how does Y flow
  (narrow with `--in src/background/`)
- `graft grep "<symbol>"` — every reference to a name you already know
- `graft callers <symbol> --depth 2` — what depends on it; run this before
  renaming, deleting, or changing a signature (`--depth all` for refactors)
- `graft map` — orientation in an unfamiliar area

Every graft command refreshes the graph itself, so no rebuild is needed after
edits. `graft build` only (re)creates the local cache on a fresh clone —
`/graft/` is gitignored; the wiring in `.claude/` and `.mcp.json` is what gets
shared.

Fall back to Grep/Read for non-code files (`docs/`, `manifest.json`,
`rules.json`) and when `graft ask` reports only lexical matches
("structural index: no entries for …") — use `graft grep` then.

- **Never run `graft init` without `--agents claude --no-global --no-statusline`**
  (and `DO_NOT_TRACK=1`). The defaults also write user-level hooks and MCP
  entries and a project `statusLine`, which would hide the user's own
  statusline. Its `--dry-run` listing ignores these flags and over-reports;
  the real run was verified 2026-10-02 to leave `~/.claude/settings.json`
  byte-identical. Telemetry is disabled in `~/.graft/telemetry.json`.
- **Never run `npx graft`** — unscoped `graft` is an unrelated npm package
  ("Full-Stack JavaScript Through Microservices"). Use `graft` or
  `npx -y @nanonets/graft`.

## Coding gotchas (standing rules — recurred twice, see `docs/LESSONS.md`)

- **Never use bare truthiness/`??`/`||` to mean "is this empty/absent?" on a
  value that can legitimately be `[]`, `0`, `''`, or a scripted `null` you
  need to observe.** `!x` and `x ?? fallback` both treat a falsy-but-present
  value as absent. Check the real predicate: `.length === 0`, `=== null`,
  etc. Seen twice: `readUntilStable`'s `!next` couldn't detect an empty
  array (`src/utils/stable-read.js`, 2026-09-26); a test harness's
  `script.shift() ?? readyNoTracks()` silently substituted the default for a
  scripted `null` instead of delivering it (`test/watch-seed.test.mjs`,
  2026-09-26).

## Project Structure

### Chrome Extension (MV3) — YouTube Subtitle Downloader

Three separate Vite builds, each with its own config:
- **`vite.config.js`** — Main bundle: popup UI (`src/popup/`) + background service worker (`src/background/`)
- **`vite.config.content.js`** — Content script (`src/content/content.js`), runs at document_idle
- **`vite.config.sniffer.js`** — Sniffer script (`src/content/sniffer.js`), runs at document_start in MAIN world

### Source Layout

```
src/
  background/       Service worker (runs in extension background)
    main.mjs          Message router — handles all chrome.runtime.onMessage types
    translation-manager.mjs  Multi-tier extraction orchestrator (brain of the app)
    batch-processor.mjs      Semaphore-based concurrent batch processor for playlists
    metadata-tier1.mjs       Lightweight InnerTube metadata fetcher (no youtubei.js)
    tier3-worker.mjs         youtubei.js wrapper (Tier 3 fallback)
  content/          Content scripts (run on YouTube pages)
    content.js        ISOLATED world — player API access, DOM extraction, caption URL fetching
    sniffer.js        MAIN world — intercepts fetch/XHR to capture timedtext URLs and response bodies
  popup/            Extension popup UI
    index.html
    popup.js          All UI logic, polling, playlist management
    style.css
  utils/
    youtube-caption-extractor.js  InnerTube API client (multiple client profiles: IOS, MWEB, WEB, ANDROID, TVHTML5)
    playlist-extractor.js         YouTube playlist browsing via InnerTube /browse API
    subtitle-formats.js           SRT, VTT, TXT converters + transcript normalizer
    languages.js                  List of ~100 supported language codes
    zip-generator.js              ZIP creation via fflate (sync, for SW context)
    video-url.js                  Pure YouTube URL → videoId detection (strict host check)
    fetch-timeout.js              fetchTextWithTimeout — 10s AbortController covering headers + body;
                                  fetchResponseWithTimeout — same deadline, raw Response (youtubei.js)
    stable-read.js                readUntilStable — re-read a live DOM snapshot until two counts agree
```

### Multi-Tier Extraction System

Transcript extraction uses fallback tiers (defined in `translation-manager.mjs`).
**Single video** (`extractWithTranslation`) runs the non-tab-nav tiers; **1.7/2C/0.5 Auth are batch-only** (verified 2026-09-25: the single-video chain never calls them); **playlist batch** (`getTranscriptForPlaylist`) uses the API/navigation tiers:

| Tier | Name | Batch? | Active Tab? | Description |
|------|------|--------|-------------|-------------|
| 0 | Network Sniffer | — | Yes | Captures timedtext URLs from intercepted fetch/XHR |
| 0.5 | Player API | — | Yes | Gets caption tracks from `movie_player.getPlayerResponse()` |
| 0 (batch) | Android Bypass | Yes | No | ANDROID client → `/player` to get transcript params (blocked for PoToken videos) |
| 0.1 (batch) | /next Transcript | Yes | No | `/youtubei/v1/next` engagement panel transcript (blocked for PoToken videos) |
| 1 | InnerTube API | Yes | No | Direct API fetch with multiple client profiles (IOS, MWEB, WEB..., LOGIN_REQUIRED) |
| 1.5 | Embed Page | Yes | No | Scrapes `/embed/{videoId}` for caption data (age-restricted, may be EMBEDDER_IDENTITY_DENIED) |
| 1.7 | Player Coercion | Yes | Yes | Seed tab once per batch, then `loadVideoById` in-page per video; MAIN-world sniffer captures timedtext. Serialized via the shared `_pageLegLock` (one lock for 1.7/2C — one tab, one mutex). Settled-fast: confirmed-this-video 0-tracks on 2 polls reports immediately. Wait-level fast-abort (`src/utils/fast-abort.js`): if that report is 0, the outer wait now aborts at arm+10s instead of the full 23s, always falling through to 2C/Auth. |
| 2 | youtube-transcript | — | Yes | Uses `@playzone/youtube-transcript` library via content script |
| 2C | Tab Navigation | Yes | Yes | **Navigates tab to watch page** — the real player solves BotGuard, sniffer captures timedtext. Serialized via the shared `_pageLegLock` (mutually exclusive with 1.7). Fast-abort: settled-0-tracks confirmed via a MAIN-world `chrome.scripting` probe (`_probeSettledNoTracks` — the ISOLATED-side read is dead) aborts the 30s wait in ~10s. |
| 3 | youtubei.js | Yes | No | Innertube SDK getTranscript. Falls back to Legacy InnerTube worker. Runs *after* Tier 1 since 2026-09-27 (demoted — 0/12 successes in every available real run). Pinned `^18.1.0` since 2026-10-03: v16's WEB client sent a shape YouTube rejected with HTTP 400; v18 gets a real response (A/B-verified, see `docs/LESSONS.md`). |
| 3 Native | | — | Yes | Content script fetch + background fetch with retry |
| 4 | Page Context | — | Yes | Injects into page to get player response, multiple format fallbacks |
| 0.5 Auth | Credentialed Fetch | Yes | Yes | Content script fetches watch page HTML with cookies, extracts ytInitialPlayerResponse captions |

**Playlist batch fallback order**: Tier 0 (Android bypass) → Tier 0.1 (/next panel) → Tier 1 (InnerTube chain) → Tier 3 (youtubei.js) → Tier 1.5 (embed page) → Tier 1.7 (player coercion) → **Tier 2C (Tab Navigation)** → Tier 0.5 Auth (credentialed fetch). Tier 3 runs *after* Tier 1 since 2026-09-27 (demoted: 0/12 successes across every available real run — order pinned by `test/tier3-order.test.mjs`). **Translated requests** (`translate: true`) skip Tiers 0.1 and 2C (neither can produce a `tlang` capture; Tier 0 takes its timedtext `&tlang=` path instead) but **do run Tier 1.7** since 2026-10-03: the player's track option carries a `translationLanguage`, the player itself then requests `&tlang=`, and `src/utils/translated-capture.js` accepts the capture ONLY when its URL's tlang equals the request's — **in both directions** (an untranslated request refuses a `tlang` capture too), with captures stored under `captureKey(lang, tlang)` so source and translated bodies of one track never overwrite each other. A player that ignores the option yields an honest fall-through to the translation-aware Tier 0.5 Auth, never a mislabel; whether the live player honors `translationLanguage` is still unconfirmed (look for `Captured … tlang=<target>` in a real batch log). Tier 3 answers a translated request only with a result marked `isTranslated: true` (its engagement-panel `getTranscript()` fallback is always source language and is skipped). So translated batches seed the watch page again (`test/tier01-translate.test.mjs`, `test/seed-translate.test.mjs`, `test/translated-capture.test.mjs`; open follow-up `docs/ISSUES.md` #19). youtubei.js `client_type` must match `CLIENTS[*].NAME` exactly (`'iOS'`, not `'IOS'`).

### Key Architectural Decisions

- **PoToken / BotGuard**: YouTube's JS VM generates runtime client attestation tokens. Timedtext requests without a valid PoToken return HTTP 200 with 0-byte body. The only reliable bypass is navigating a real YouTube tab to the watch page where the native player solves BotGuard.
- **MAIN-world Bridge**: `sniffer.js` (document_start, MAIN world) stores captured transcript bodies in `window.__ytsub_captured_transcripts` global. `content.js` (document_idle, ISOLATED world) injects a bootstrap script that reads this global and relays it via `postMessage` to the ISOLATED-world `capturedTranscripts` Map. This solves the timing gap where the content script's message listener doesn't exist when the sniffer fires at document_start.
- **event.source filtering**: `content.js` currently does not filter `YTSUB_CAPTURED_TRANSCRIPT` by `event.source`. The old reason (the embed-iframe tier relayed via `window.parent.postMessage()`) is gone — that tier and the sniffer's iframe relay were deleted 2026-09-29 and the sniffer is top-frame-only — so adding `event.source === window` is now a safe hardening against child-iframe forgery (`docs/ISSUES.md`), not yet done.
- **Tab Navigation**: Shares the `_pageLegLock` promise-chain mutex with Tier 1.7 so no two page-leg operations ever drive the pinned tab concurrently. Navigates tab to `watch?v=VIDEO_ID&list=PLAYLIST_ID` to preserve playlist sidebar. Saves `_originalTabUrl` on first navigation and restores it after batch completes.
- **DNR rules** (`rules.json` — 2 rules, ids 1/3; ids 4/5 deleted 2026-09-29):
  - id 1: Set `Origin`/`Referer` on `youtubei/v1` requests, remove `Sec-Ch-Ua*` request headers
  - id 3: Set `Origin`/`Referer` on `youtube.com/watch` API requests
  (There is no timedtext iOS-UA-spoof rule. Never add rules that strip `X-Frame-Options`/CSP from YouTube responses: the deleted ids 4/5 did that for every tab — clickjacking exposure — to serve a tier with no callers. Pinned by `test/manifest-hygiene.test.mjs`, which also forbids `all_frames:true` content scripts, so the MAIN-world sniffer never runs in third-party YouTube embeds.)
- **fflate** (sync) used for ZIP creation since Web Workers don't work in Service Workers
- **Batch processing** uses a semaphore (concurrency: 3, 300ms delay with jitter) to rate-limit playlist downloads
- **Progress polling**: background writes to `chrome.storage.local`, popup polls every 500ms
- **Deduplication**: TranslationManager deduplicates concurrent metadata/transcript requests by video ID
- **Atomic progress updates**: batch download progress reads-merges-writes to prevent stale state from SW restarts
- **`content.js` runs in ISOLATED world** (no `"world": "MAIN"` in manifest) — this means it cannot access page-defined JS variables (ytInitialPlayerResponse, etc.) directly. Must use script injection for MAIN-world access or `window.__ytsub_*` globals.
