[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hellpanderrr/YTSubExtract)


# YTSubExtract: YouTube Subtitle Extractor (MV3)

A Chrome Extension for extracting subtitles from YouTube videos using a multi-tier fallback system. Built for Manifest V3.

## Tech Stack

| Component | Library / Tool | Purpose |
| :--- | :--- | :--- |
| Network Interception | Vanilla JS | MAIN world script intercepts `fetch`/`XHR` for URL capture |
| Player API | Vanilla JS | Direct `movie_player.getPlayerResponse()` access |
| API Client | `youtube-caption-extractor` (modified) | Android/iOS client impersonation |
| InnerTube API | `youtubei.js` | Full InnerTube client with protobuf support |
| DOM Extraction | `@playzone/youtube-transcript` | Extracts transcripts from `ytInitialPlayerResponse` |
| Text Processing | `he` | HTML entity decoding |
| Sanitization | `striptags` | HTML/XML tag stripping |
| Bundler | `vite` | Build tool with multiple configurations |
| Packaging | `crx` & `zip-a-folder` | Chrome Web Store distribution |

## Architecture

The extension uses a priority fallback model with multiple extraction methods.

### Tier 0: Network Sniffer

**Mechanism**: Content script injected into MAIN world at `document_start` intercepts all `fetch` and `XMLHttpRequest` calls.

**Use Case**: Videos with subtitles already loaded.

### Tier 0.5: Player API

**Mechanism**: Direct access to `document.getElementById('movie_player').getPlayerResponse()`.


**Use Case**: SPA navigation where URL changes without page reload. Includes retry logic (3 attempts, 500ms delay).

### Tier 1.5: Embed Page Extraction

**Mechanism**: Fetches the embed page (`/embed/{videoId}`) and extracts `ytInitialPlayerResponse` from HTML.

**Use Case**: Guest mode (no login required), works without authentication and age-restricted videos.

**Timeout Protection**: 8-second timeout prevents hanging on slow responses.

### Tier 1: Android/iOS API Client

**Mechanism**: HTTP request to `https://www.youtube.com/youtubei/v1` masquerading as YouTube mobile app.

**Features**: 
- `contentCheckOk: true` and `racyCheckOk: true` flags for restricted content
- `tlang` parameter injection for server-side translation

### Tier 2: DOM Extraction

**Mechanism**: Content script accesses `ytInitialPlayerResponse` object from page context.

**Use Case**: API blocked (403/429), leverages existing session cookies.

### Tier 3: InnerTube Emulation

**Mechanism**: Full `youtubei.js` session for desktop client handshake.

**Use Case**: Complex signature deciphering, obfuscated metadata.

### Tier 4: Main World Fetcher

**Mechanism**: Fetches timedtext URLs from MAIN world context to bypass empty response protection.

**Use Case**: Age-restricted videos, YouTube returning 200 OK with empty body.

## Extraction Cascades

### Metadata Cascade (Available Languages)
```
Parallel Batch: [Tier 0.5, Tier 1.5, Tier 1] → Tier 2 → Tier 3 → Tier 4
```
Tiers 0.5, 1.5, and 1 execute in parallel for faster initialization. Results processed in priority order (0.5 → 1 → 1.5). Tier 0 skipped for metadata (captures single language URL, metadata needs all languages).

**Timeout Protection**: Each tier has 8-10 second timeout to prevent hanging.

### Download Cascade (Subtitle Content)
```
Tier 0 → Tier 0.5 → Tier 1 → Tier 2 → Tier 3 → Tier 4
```
Tier 0 first (use captured URL directly if available).

## MAIN World Injection

Uses Manifest V3's `"world": "MAIN"` feature:

```json
{
  "matches": ["*://*.youtube.com/*"],
  "js": ["sniffer.js"],
  "run_at": "document_start",
  "world": "MAIN"
}
```

**Benefits**:
- Intercepts `window.fetch` and `XMLHttpRequest` before YouTube's code
- No deprecated `webRequest` API required
- Captures early network requests at `document_start`

**Communication Flow**:
```
sniffer.js (MAIN world)
    ↓ window.postMessage ↓
content.js (ISOLATED world)
    ↓ chrome.runtime.sendMessage ↓
background.js (Service Worker)
```

## Performance

- **Parallel Tier Execution**: Tiers 0.5, 1.5, 1 run simultaneously for 2-8s initialization (was 10-15s sequential).
- **Format Switching**: Raw transcript cached in memory (`metadata:${videoId}`). SRT/VTT/TXT conversion is instant.
- **State Persistence**: `chrome.storage.local` for user preferences including per-playlist language selections.
- **URL Expiration**: Sniffer-captured URLs checked before use.
- **Timeout Protection**: All HTTP requests have timeouts (8s for embed pages, 10s for API calls) to prevent UI freezing.

## Features

### Playlist Mode

Batch download subtitles from YouTube playlists:
- Select/deselect individual videos or all at once
- Per-playlist language preferences (saved to storage)
- ZIP packaging with organized filenames
- Progress tracking with ARIA accessibility support
- Resume on browser restart via persistent progress storage

### Translation Support

Server-side translation via `tlang` parameter:
- Automatic translation to 50+ languages
- Caching optimized to exclude targetLang when not translating
- Source language auto-detection with 'en' preference

### ARIA Accessibility

Screen reader compatible progress indicators:
- `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`
- `aria-live="polite"` for progress announcements
- Proper focus management during downloads

## Build

### Prerequisites
- Node.js 16+
- npm 8+

### Commands
```bash
# Install dependencies
npm install

# Development (Hot Reload)
npm run dev

# Production Build
npm run build

# Chrome Web Store ZIP
npm run zip
# Output: builds/extension.zip
```

### Build Configuration
Three Vite configurations:
- `vite.config.js` - Background script and popup
- `vite.config.content.js` - Content script (ISOLATED world)
- `vite.config.sniffer.js` - Network sniffer (MAIN world)

