[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hellpanderrr/YTSubExtract)


# YTSubExtract: YouTube Subtitle Extractor (MV3)

A high-performance Chrome Extension designed to extract subtitles from YouTube videos using a robust **4-Tier Fallback System**. Built for reliability and speed.

## 🛠️ Tech Stack & Libraries

This extension is built with **Vanilla JavaScript (ES Modules)** and **Vite**, targeting **Chrome Manifest V3**.

| Component | Library / Tool | Purpose |
| :--- | :--- | :--- |
| **Core Logic** | **`youtube-caption-extractor`** (Modified) | The foundation for **Tier 1**. We vendored and heavily modified this library to support **Android Client** impersonation. |
| **API Interaction** | **`youtubei.js`** | Full-featured InnerTube API client. Handles complex protobuf parsing and mimics desktop client behavior (Tier 3). |
| **DOM Extraction** | **`@playzone/youtube-transcript`** | Lightweight scraper for extracting transcripts directly from the `ytInitialPlayerResponse` object in the DOM (Tier 2/4). |
| **Text Processing** | **`he`** | Robust HTML entity decoder. Converts raw XML entities (e.g., `&amp;`, `&#39;`) into readable text. |
| **Sanitization** | **`striptags`** | High-performance HTML/XML tag stripper. Removes `<text>` and formatting tags from raw caption data. |
| **Bundler** | **`vite`** | Modern build tool for extremely fast HMR and optimized production builds. |
| **Packaging** | **`crx`** & **`zip-a-folder`** | Automates the creation of `.crx` files and `.zip` archives for Chrome Web Store distribution. |

## 🏗️ Technical Architecture

The extension operates on a **Priority Fallback Model** to ensure 100% extraction success rate for playable videos.

### 1. Tier 1: Android API Client (Primary)
*   **Mechanism**: The Service Worker constructs a raw HTTP request to `https://www.youtube.com/youtubei/v1` masquerading as the **YouTube Android App** (`com.google.android.youtube`).
*   **Why**: The Android client API is fast and efficient.
*   **Translation**: Injects the `&tlang={targetLang}` parameter directly into the caption URL for server-side translation by Google.

### 2. Tier 2: DOM & Page Context (Fallback)
*   **Mechanism**: A Content Script injects into the active tab to access the window's `ytInitialPlayerResponse` object.
*   **Why**: If the API is blocked (403/429), this method leverages the user's **existing session cookies** and signed-in state to retrieve the caption tracks already loaded by the player.
*   **Library**: Uses `@playzone/youtube-transcript`.

### 3. Tier 3: Native InnerTube Emulation (Last Resort)
*   **Mechanism**: Initializes a heavy `youtubei.js` session within the Service Worker to perform a full "desktop" handshake.
*   **Why**: Handles edge cases where video metadata is obfuscated or requires complex signature deciphering (sig/n-parameter).

### 4. Tier 4: Page Context Injection (Ultimate Fallback)
*   **Mechanism**: Injects a micro-script into the page to read the `ytInitialPlayerResponse` global variable directly from the user's browser session.
*   **Why**: If all API requests fail (e.g., due to strict API limitations), this method uses the data the user's browser *already has*. **Note**: This requires the user to be able to play the video.

### ⚡ Performance & Caching
*   **Instant Format Switching**: The extension caches the *raw parsed transcript* (JSON) in memory (`metadata:${videoId}`). Switching between **SRT**, **VTT**, and **TXT** formats is instant (0ms latency) as it re-serializes the cached data instead of re-fetching.
*   **State Persistence**: Uses `chrome.storage.local` to persist user preferences (Translation enabled/disabled, Target Language) across sessions.

## 📦 Installation & Build

### Prerequisites
*   Node.js 16+
*   npm 8+

### Setup
```bash
# Clone repository
git clone https://github.com/hellpanderrr/YTSubExtract.git

# Install dependencies
npm install

# Development (Hot Reload)
npm run dev

# Production Build
npm run build
```

### Release
To generate a production-ready ZIP for the Chrome Web Store:
```bash
npm run zip
# Output: builds/extension.zip
```
