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

The extension uses a priority fallback model with multiple extraction methods. **Note:** Due to YouTube's PoToken anti-bot measures (2025), many direct API clients are now blocked. The extension has been optimized to prioritize working methods.

### Current Tier Status

#### For Single Videos (Popup Flow)

| Tier | Method | Status | When It Works |
|------|--------|--------|---------------|
| **Tier 0.5** | Player API from active tab | ✅ Works | User has YouTube video open in active tab |
| **Tier 1.5** | Embed page scraping | ⚠️ Limited | Often blocked by CSP/redirects |
| **Tier 1** | Direct InnerTube API | ⚠️ **PARTIAL** | IOS works; MWEB/WEB_EMBEDDED require PoToken; ANDROID deprecated |
| **Tier 2** | Content script injection | ⚠️ Timeout | Requires active tab, often hangs |
| **Tier 3** | youtubei.js library | ✅ **PRIMARY** | Most reliable method, no active tab needed |
| **Tier 4** | Page context extraction | ⚠️ Slow | Last resort, requires active tab |

#### For Playlist Downloads (Background)

| Tier | Method | Status | Notes |
|------|--------|--------|-------|
| **Tier 1** (API clients) | youtube-caption-extractor | ⚠️ Partial | IOS works; others blocked or deprecated |
| **Tier 1.5** | Embed page | ❌ Broken | No active tab in service worker context |
| **Tier 3** | youtubei.js | ✅ **PRIMARY** | Only reliable method for playlists |

### Phase 1 Optimizations (Implemented)

1. **New Client Priority** (IOS → MWEB → WEB → WEB_EMBEDDED → TVHTML5 → ANDROID)
   - Based on yt-dlp's successful client fallback chain
   - WEB client added; ANDROID moved to last (deprecated by YouTube in 2026)
   - Fast-fail on UNPLAYABLE/ERROR/LOGIN_REQUIRED responses
   - Client-specific payloads: only ANDROID gets legacy params/playbackContext

2. **VisitorData Caching** (24h)
   - Reduces bot-like behavior
   - Cached in memory, persists during service worker lifetime

3. **Playlist-First Tier 3**
   - Skips slow/broken Tier 0.5/1/1.5 for playlist downloads
   - ~2-3x faster per video in playlist mode

### Phase 2 Fixes (Latest)

4. **Client-Specific Payloads** — Only ANDROID gets legacy `params`/`playbackContext`; others use minimal payload
5. **User-Agent Consistency** — Fixed DNR rules to match client type (removed forced ANDROID UA override)
6. **IOS Metadata** — Updated device model (`iPhone17,2`) and OS version (`18.4.1`) to match current UA

### Tier Details

#### Tier 0.5: Player API
**Mechanism**: Direct access to `document.getElementById('movie_player').getPlayerResponse()`.  
**Use Case**: Fastest method when user has YouTube open in active tab.  
**Status**: ✅ Reliable when active tab available.

#### Tier 1: Direct API Clients (PARTIAL)
**Mechanism**: HTTP requests to `youtubei/v1` with client-specific payloads.  
**Status**: ⚠️ **IOS works**, others require PoToken or deprecated:
- ✅ **IOS**: Minimal payload, works for most videos (primary Tier 1 client)
- ❌ **MWEB/WEB**: Require PoToken (enforcement rolled out Apr 2026)
- ❌ **WEB_EMBEDDED**: Requires embed auth + PoToken
- ❌ **ANDROID**: Deprecated by YouTube for programmatic access (early 2026)
- ❌ **TVHTML5**: HTTP 400 — payload incompatible

#### Tier 3: InnerTube Emulation (PRIMARY)
**Mechanism**: Full `youtubei.js` session with proper handshake.  
**Use Case**: **Primary method** for both single videos and playlists.  
**Status**: ✅ Works reliably, handles complex signatures automatically.

#### Tier 1.5: Embed Page Extraction
**Mechanism**: Fetches `/embed/{videoId}` and extracts `ytInitialPlayerResponse`.  
**Status**: ⚠️ Often blocked by CSP or returns empty responses.

#### Tier 4: Main World Fetcher
**Mechanism**: Fetches timedtext URLs from MAIN world context.  
**Use Case**: Bypasses empty response protection for age-restricted videos.

## Extraction Cascades

### Metadata Cascade (Single Video - Popup)
```text
Parallel: [Tier 0.5, Tier 1.5] → Tier 1 (API) → Tier 2 → Tier 3 → Tier 4
```
- Tiers 0.5 and 1.5 execute in parallel first (cheap, fast when available)
- Tier 1 (direct API) usually fails with UNPLAYABLE — fast-fail to Tier 3
- **Tier 3 is primary fallback** and handles most cases reliably

### Download Cascade (Single Video - Popup)
```text
Tier 0 (sniffer) → Tier 0.5 → Tier 1 → Tier 2 → Tier 3 → Tier 4
```
- Tier 0: Uses captured URL from network sniffer (instant if available)
- Falls back through tiers until one succeeds

### Playlist Cascade (Background Service Worker)
```text
Tier 3 (PRIMARY) → Tier 1 (fallback) → Tier 1.5 (last resort)
```
- **Optimized**: Starts with Tier 3 immediately (youtubei.js)
- Skips broken/slow tiers (0.5, 1, 1.5) that waste 2-3s per video
- ~2-3x faster than previous implementation

**Timeout Protection**: Each tier has 8-10 second timeout to prevent UI freezing.

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

- **Parallel Tier Execution**: Tiers 0.5 and 1.5 run in parallel (2-8s). Tier 1 is fallback if both fail.
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

