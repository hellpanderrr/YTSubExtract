[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hellpanderrr/YTSubExtract)


# YTSubExtract: YouTube Subtitle Extractor (MV3)

A Chrome Extension for extracting subtitles from YouTube videos and playlists using a multi-tier fallback system. Built for Manifest V3.

## Tech Stack

| Component | Library / Tool | Purpose |
| :--- | :--- | :--- |
| Network Interception | Vanilla JS | MAIN-world script intercepts `fetch`/`XHR` for timedtext capture |
| Player API | Vanilla JS | Direct `movie_player` access for track lists and track switching |
| API Client | `youtube-caption-extractor` (modified) | InnerTube client impersonation (IOS, MWEB, WEB, TVHTML5, ANDROID) |
| InnerTube SDK | `youtubei.js` 18 | Tier 3 fallback |
| DOM Extraction | `@playzone/youtube-transcript` | Tier 2 (content-script) extraction |
| HTML entities | `he` | Caption text entity decoding |
| Sanitization | `striptags` | HTML/XML tag stripping |
| ZIP packaging | `fflate` | Playlist ZIPs (pure JS — works in the service worker) |
| Bundler | `vite` | Three build configurations |
| Packager | `crx` + `node-rsa` | Optional signed `.crx` for local testing |
| Tests | `node:test`, Playwright | Unit suite + headless e2e suite |

## Architecture

The extension uses a priority fallback model. Due to YouTube's PoToken / BotGuard anti-bot enforcement, direct API clients are frequently blocked; the tiers that use a real signed-in player tab are the ones that keep working at scale.

**Two MAIN-world channels.** The page's player API (`loadVideoById`, `getPlayerResponse`) lives in the page's MAIN world. The ISOLATED content script cannot read it directly, and script injection from ISOLATED does not even execute on youtube.com. So all page-JS access goes through either the `document_start` MAIN-world sniffer (via `window.postMessage`) or `chrome.scripting.executeScript({world:'MAIN'})` from the background.

### Single-video flow (popup)

**Metadata / language list** (`extractWithTranslation` → metadata):
```text
parallel [Tier 0.5, Tier 1.5] → Tier 1 (API) → Tier 3 (youtubei.js) → Tier 2 → Tier 4
```

**Transcript download**:
| Tier | Method | Notes |
|------|--------|-------|
| 0 | Network sniffer | Instant if the player already fetched the `timedtext` URL |
| 0.5 | Player API track URL | Reads caption tracks from the open player |
| 1 | InnerTube clients | IOS first; others often need a PoToken |
| 1.5 | Embed page | Age-restricted fallback; sometimes blocked |
| 2 | Content script | `@playzone/youtube-transcript` |
| 3 | youtubei.js (+ legacy InnerTube) | No active tab needed; demoted below Tier 1 in batch since it had no recorded real wins |
| 4 | Page context injection | Last resort |

### Playlist batch flow (`getTranscriptForPlaylist`, background)

```text
Tier 0 (Android /player) → Tier 0.1 (/next panel) → Tier 1 (InnerTube chain)
→ Tier 3 (youtubei.js) → Tier 1.5 (embed) → Tier 1.7 (player coercion)
→ Tier 2C (tab navigation) → Tier 0.5 Auth (credentialed fetch)
```

- **Tier 1.7** seeds one YouTube tab once per batch, then drives `loadVideoById` per video so the real player solves BotGuard; the sniffer captures the resulting `timedtext` response.
- **Tier 2C** navigates the tab to the watch page and waits for the same capture. It fast-aborts (~10s instead of 30s) when the player is confirmed settled on the video with zero caption tracks.
- **Tier 0.5 Auth** fetches the watch page HTML with the user's cookies and extracts `ytInitialPlayerResponse` — the translation-aware last resort.
- Tiers 1.7 and 2C share one promise-chain mutex (one tab, one page-leg operation at a time) and restore the user's original tab URL after the batch.

**Translated requests** (`translate: true`) skip Tiers 0.1 and 2C (they can never produce a `tlang` capture). Tier 0 uses the timedtext `&tlang=` path; Tier 1.7 arms the player's caption track with `translationLanguage`, making the player itself request `&tlang=`. A capture is accepted **only** when its URL's `tlang` matches the request (in both directions — an untranslated request refuses a `tlang` capture too), so a player that ignores the option falls through honestly instead of shipping untranslated text under a translated filename.

### PoToken / bot check

Timedtext requests without a valid PoToken return HTTP 200 with a 0-byte body. The reliable bypass is a real player tab (Tiers 1.7 / 2C / 0.5 Auth). When YouTube shows "Sign in to confirm you're not a bot", every API-only tier fails and the tab-based tiers carry the batch.

## Permissions

| Permission | Why |
| :--- | :--- |
| `activeTab`, host access to youtube.com / youtube-nocookie.com | Read the playlist/video page the user is on |
| `storage` | Preferences, per-playlist language selection, download progress |
| `declarativeNetRequest` | Set `Origin`/`Referer` on YouTube API requests (2 rules) |
| `downloads` | Save the subtitle file / playlist ZIP the user requested |
| `scripting` | Run a small static function in the page to read the player state (video ID, caption tracks, track switching) when the MAIN-world sniffer bridge is unreachable |

No remote code, no `eval`, no tracking, no external servers. All requests go to YouTube endpoints.

## Features

### Playlist Mode
- Lists the playlist on the current page (rows are matched to the opened playlist by their `list=` identity — a wrong-list page read was a fixed regression)
- Select/deselect videos, per-playlist language preferences
- ZIP download with organized filenames, real-time progress, and a **Stop** button
- Stop during the setup phase cancels the whole run; subtitles that already finished are still delivered
- Progress storage survives popup close and service-worker restarts

### Translation
- Server-side translation via `tlang` (single videos and playlists)
- Playlist translation is verified: only captures whose `tlang` matches the request are accepted
- Source language auto-detection (no silent fallback to English)

### Formats
- SRT, VTT, TXT (clean, timestamp-free output for AI prompts)

### Accessibility
- `role="progressbar"` with `aria-*` attributes and `aria-live` announcements

## Build

### Prerequisites
- Node.js **22.3+** (the unit suite uses `node:test`'s `mock.module`; floor verified on 22.3.0)
- npm 8+

### Commands
```bash
npm install

npm run dev          # Vite dev server
npm run build        # build all three bundles (main, content, sniffer)
npm run zip          # build + builds/extension.zip for the Web Store
npm run pack         # build + signed builds/extension.crx (local pack)

npm test             # unit suite (node:test, no network/browser)
npm run e2e          # Playwright suite — needs `npm run e2e:login` once
node scripts/mutate-playlist-rows.mjs        # mutation harness, exit 0 = all mutants killed
node scripts/mutate-translated-capture.mjs   # mutation harness, exit 0 = all mutants killed

npm run bump X.Y.Z  # bump every version copy (refuses on disagreement)
npm run notes        # print the What's New block used for release notes
```

### Build configuration
Three Vite configs:
- `vite.config.js` — background service worker + popup
- `vite.config.content.js` — content script (ISOLATED world)
- `vite.config.sniffer.js` — network sniffer (MAIN world)

## Testing & CI

- **Unit tests** (`test/*.test.mjs`, 137 tests): batch Stop state machine, tab pinning, translation gating, capture store keys, playlist row identity, manifest/DNR hygiene, the release rail rules, and more.
- **Mutation harnesses** for the two highest-risk helpers (`playlist-rows`, `translated-capture`): every seeded bug must be caught.
- **Playwright e2e** (`e2e/`): smoke, single-video, playlist listing, batch download. Some specs need a signed-in profile (`npm run e2e:login`) and env URLs; headless runs are dominated by YouTube's bot check — see `docs/ISSUES.md` #1.
- **CI**: `.github/workflows/test.yml` runs the unit suite + a full build on every push/PR. A self-hosted weekly canary (`weekly-canary.yml`) exercises a real playlist.

## Releasing

One rail: `.github/workflows/release.yml` (dispatch-only, main-only).
- Version comes from `manifest.json`; notes come from the top **What's New** block of `STORE_DESCRIPTION.md`.
- It refuses an existing tag, gates on `npm test`, builds **one** zip, and uses it for both the GitHub Release (tag at the dispatched commit) and the Chrome Web Store upload (`publish: false` — the dashboard submit stays manual).
- `announce.yml` posts the same block to Discussions → Announcements, run after the store shows the version live.

## Support

- Questions and issues: [Discussions](https://github.com/hellpanderrr/YTSubExtract/discussions)
- Disclaimer: YouTube is a trademark of Google LLC. Use of this trademark is subject to Google Permissions.
