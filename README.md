# YouTube Subtitle Downloader (MV3)

A powerful Chrome Extension to download YouTube subtitles with a 3-tier fallback system and auto-translation capabilities.

## 🏗️ Architecture

This extension uses a robust **3-Tier Fallback System** to ensure subtitles can be extracted even when YouTube changes its API or blocks certain requests.

### 🔹 Tier 1: Android Client API (Primary)
- **Method**: Direct API call mimicking the official YouTube Android App.
- **Why**: The Web client often returns empty captions for age-restricted or region-locked videos. The Android client is much more reliable.
- **Translation**: Supports the `tlang` parameter for server-side translation (Google Translate API).
- **Location**: Runs in the **Background Service Worker**.

### 🔹 Tier 2: Web Client / Page Context (Fallback)
- **Method**: Extracts data directly from the video page's initial data (ytInitialPlayerResponse).
- **Why**: If the API call fails (e.g., due to IP blocking), this method uses the user's existing session cookies and page context.
- **Location**: Runs in the **Content Script** (in the context of the active tab).

### 🔹 Tier 3: Native Parsing & InnerTube (Last Resort)
- **Method**: Uses the heavy `youtubei.js` library to emulate a full desktop client session + a "Native" fetcher that intercepts the video page's own `fmt=json3` resources.
- **Why**: If all else fails, this method attempts to parse the raw data streams that the YouTube player itself uses.
- **Location**: Hybrid (Background Worker + Content Script).

---

## 📚 Libraries & Tools

We use a specific set of libraries to handle different aspects of the extraction process:

### Core Logic
| Library | Purpose |
| :--- | :--- |
| **`he`** | HTML Entity decoder. Used to clean up raw XML captions (e.g., converts `&amp;` to `&`) from Tier 1. |
| **`striptags`** | Removes XML/HTML tags from the raw caption text in Tier 1. |
| **`youtubei.js`** | A powerful wrapper around YouTube's internal API. Used for deep metadata extraction and the Tier 3 fallback mechanism. |
| **`@playzone/youtube-transcript`** | A lightweight library used in Tier 2 to extract transcripts from the DOM/Window object. |

### Build System
| Tool | Purpose |
| :--- | :--- |
| **`vite`** | The build tool used to bundle the extension (ES modules -> browser-compatible JS). Supports HMR (Hot Module Replacement) for development. |
| **`crx`** | Used to pack the extension into a `.crx` file for distribution. |
| **`zip-a-folder`** | Creates the `.zip` archive for the Chrome Web Store. |

---

## 🚀 Installation for Development

1. Clone the repository.
2. Run `npm install`.
3. Run `npm run dev` for hot-reload or `npm run build` for production.
4. Load the `dist` folder in Chrome Extensions (Developer Mode).

## 📦 Build & Release

### Manual Build
To create a zip file for the store:
```bash
npm run zip
```
The output will be in `builds/extension.zip`.

### GitHub Actions (CI/CD)
This project includes two manual workflows for release management:

1. **Build & Create Release (GitHub)**:
   - Go to **Actions** -> Select workflow -> Click **Run workflow**.
   - Creates a GitHub Release with the `extension.zip` attached.

2. **Publish to Chrome Store**:
   - Go to **Actions** -> Select workflow -> Click **Run workflow**.
   - Automatically uploads and publishes the extension to the Chrome Web Store.
   - *Requires `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, `EXTENSION_ID` secrets.*
