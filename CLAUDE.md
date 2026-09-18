# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

- `npm run dev` — Start Vite dev server
- `npm run build` — Build all three bundles (main, content, sniffer)
- `npm run pack` — Build + create signed `.crx`
- `npm run zip` — Build + create `.zip` for Chrome Web Store upload
- `npm run clean` — Remove `dist/` and `builds/`

### E2E tests (Playwright, headless)

- `npm run e2e:login` — ONE-TIME: opens a window to sign into YouTube in the
  dedicated `.e2e-profile/`. Required for login-gated specs; they skip without it.
- `npm run e2e` — build, then run the whole suite
- `npm run e2e:smoke` — harness self-test only (no YouTube content needed)
- `npm run e2e:headed` — run with a visible browser

Specs live in `e2e/`; see `e2e/README.md` for env vars and per-spec coverage.
Known-unresolved issues with this harness are logged in `docs/LESSONS.md`.

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
```

### Multi-Tier Extraction System

Transcript extraction uses fallback tiers (defined in `translation-manager.mjs`).
**Single video** (`extractWithTranslation`) uses all tiers; **playlist batch** (`getTranscriptForPlaylist`) uses only the API/navigation tiers:

| Tier | Name | Batch? | Active Tab? | Description |
|------|------|--------|-------------|-------------|
| 0 | Network Sniffer | — | Yes | Captures timedtext URLs from intercepted fetch/XHR |
| 0.5 | Player API | — | Yes | Gets caption tracks from `movie_player.getPlayerResponse()` |
| 0 (batch) | Android Bypass | Yes | No | ANDROID client → `/player` to get transcript params (blocked for PoToken videos) |
| 0.1 (batch) | /next Transcript | Yes | No | `/youtubei/v1/next` engagement panel transcript (blocked for PoToken videos) |
| 1 | InnerTube API | Yes | No | Direct API fetch with multiple client profiles (IOS, MWEB, WEB..., LOGIN_REQUIRED) |
| 1.5 | Embed Page | Yes | No | Scrapes `/embed/{videoId}` for caption data (age-restricted, may be EMBEDDER_IDENTITY_DENIED) |
| 2 | youtube-transcript | — | Yes | Uses `@playzone/youtube-transcript` library via content script |
| 2C | Tab Navigation | Yes | Yes | **Navigates tab to watch page** — the real player solves BotGuard, sniffer captures timedtext. The only reliable method for PoToken-restricted videos. Serialized via `_tabNavLock` promise chain. |
| 3 | youtubei.js | Yes | No | Innertube SDK getTranscript. Falls back to Legacy InnerTube worker |
| 3 Native | | — | Yes | Content script fetch + background fetch with retry |
| 4 | Page Context | — | Yes | Injects into page to get player response, multiple format fallbacks |
| 0.5 Auth | Credentialed Fetch | Yes | Yes | Content script fetches watch page HTML with cookies, extracts ytInitialPlayerResponse captions |

**Playlist batch fallback order**: Tier 0 (Android bypass) → Tier 0.1 (/next panel) → Tier 3 (youtubei.js) → Tier 1 (InnerTube chain) → Tier 1.5 (embed page) → **Tier 2C (Tab Navigation)** → Tier 0.5 Auth (credentialed fetch)

### Key Architectural Decisions

- **PoToken / BotGuard**: YouTube's JS VM generates runtime client attestation tokens. Timedtext requests without a valid PoToken return HTTP 200 with 0-byte body. The only reliable bypass is navigating a real YouTube tab to the watch page where the native player solves BotGuard.
- **MAIN-world Bridge**: `sniffer.js` (document_start, MAIN world) stores captured transcript bodies in `window.__ytsub_captured_transcripts` global. `content.js` (document_idle, ISOLATED world) injects a bootstrap script that reads this global and relays it via `postMessage` to the ISOLATED-world `capturedTranscripts` Map. This solves the timing gap where the content script's message listener doesn't exist when the sniffer fires at document_start.
- **event.source filtering**: `content.js` **must not** use `if (event.source !== window) return;` for `YTSUB_CAPTURED_TRANSCRIPT` messages — iframes send `window.parent.postMessage()` where `event.source` is the iframe window, not the top window.
- **Tab Navigation**: Uses a promise-chain mutex (`_tabNavLock`) to serialize tab navigations during batch processing. Navigates tab to `watch?v=VIDEO_ID&list=PLAYLIST_ID` to preserve playlist sidebar. Saves `_originalTabUrl` on first navigation and restores it after batch completes.
- **DNR rules** (`rules.json`):
  - Rule 1: Remove `X-Frame-Options`, `Content-Security-Policy`, `CSP-Report-Only` from `youtube.com` sub_frame responses (enables watch page in iframe)
  - Rule 2: Same for `youtube-nocookie.com` sub_frames
  - Rule 3: Set `Origin: https://www.youtube.com` on youtube.com API requests
  - Rule 4: Remove `Sec-Ch-Ua` headers, spoof iOS UA on timedtext requests
- **fflate** (sync) used for ZIP creation since Web Workers don't work in Service Workers
- **Batch processing** uses a semaphore (concurrency: 3, 300ms delay with jitter) to rate-limit playlist downloads
- **Progress polling**: background writes to `chrome.storage.local`, popup polls every 500ms
- **Deduplication**: TranslationManager deduplicates concurrent metadata/transcript requests by video ID
- **Atomic progress updates**: batch download progress reads-merges-writes to prevent stale state from SW restarts
- **`content.js` runs in ISOLATED world** (no `"world": "MAIN"` in manifest) — this means it cannot access page-defined JS variables (ytInitialPlayerResponse, etc.) directly. Must use script injection for MAIN-world access or `window.__ytsub_*` globals.
