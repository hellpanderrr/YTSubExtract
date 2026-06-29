
// === UNIVERSAL TRANSLATION MANAGER ===
// Handles all 3 libraries + YouTube Native API

import { getSubtitles, getLanguages, getVideoInfo, getTranscriptViaAndroid, getTranscriptViaNext } from '../utils/youtube-caption-extractor.js';
import { fetchTier3Transcript, getVideoMetadata as getVideoMetadataTier3 } from './tier3-worker.mjs';
import { SUPPORTED_LANGUAGES } from '../utils/languages.js';
import he from 'he';

export class TranslationManager {
  constructor() {
    this.availableLanguages = null;
    this.cache = new Map();
    this.MAX_CACHE_SIZE = 100; // Limit cache size to prevent memory leaks

    // Deduplication maps to prevent concurrent duplicate requests
    this.pendingMetadataRequests = new Map(); // key: videoId -> Promise
    this.pendingTranscriptRequests = new Map(); // key: videoId:lang:translate:targetLang -> Promise

    // Tab navigation lock (serializes tab navigation to prevent conflicts)
    this._tabNavLock = Promise.resolve();

    // Original tab URL before tab navigation (used to restore after batch)
    this._originalTabUrl = null;
  }

  /**
   * Add to cache with size limit (simple LRU-ish: remove first added)
   * Thread-safety: Uses while loop to handle concurrent size changes
   */
  _setCache(key, value) {
    // Guard against edge case: empty cache with size > 0
    if (this.cache.size === 0 && this.MAX_CACHE_SIZE > 0) {
      this.cache.set(key, value);
      return;
    }

    // Re-check size to handle concurrent additions correctly
    let attempts = 0;
    const maxAttempts = this.MAX_CACHE_SIZE + 10; // Safety limit
    while (this.cache.size >= this.MAX_CACHE_SIZE && attempts < maxAttempts) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break; // Should not happen with size > 0
      this.cache.delete(firstKey);
      attempts++;
    }
    this.cache.set(key, value);
  }

  // ─────────────────────────────────────────────────────────────
  // Cache Management
  // ─────────────────────────────────────────────────────────────
  clearCache(videoId) {
    if (videoId) {
      // Clear metadata
      this.cache.delete(`metadata:${videoId}`);
      
      // Clear transcripts for this video
      for (const key of this.cache.keys()) {
        if (key.startsWith(`transcript:${videoId}`)) {
          this.cache.delete(key);
        }
      }
      console.log(`[TranslationManager] Cleared cache for ${videoId}`);
    } else {
      this.cache.clear();
      console.log('[TranslationManager] Cleared all cache');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // TIER 0.5: Player API (instant access from movie_player)
  // ─────────────────────────────────────────────────────────────
  async _getLanguagesTier0_5(videoId) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve({ languages: [], title: null });
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PLAYER_TRACKS', videoId }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Tier 0.5] Runtime error:', chrome.runtime.lastError.message);
            return resolve({ languages: [], title: null });
          }
          
          if (!response?.success) {
            if (response?.logs) {
              console.log('[Tier 0.5] Logs:', response.logs);
            }
            return resolve({ languages: [], title: null });
          }
          
          const tracks = response.tracks || [];
          const languages = tracks.map(t => ({
            code: t.languageCode,
            name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
            isAuto: t.kind === 'asr'
          }));
          
          console.log(`[Tier 0.5] Success: ${languages.length} languages, title: ${response.title}`);
          resolve({ languages, title: response.title });
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TIER 0.5: Playlist DOM Extraction (for private playlists)
  // ─────────────────────────────────────────────────────────────
  async _getPlaylistVideosTier0_5(playlistId) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          console.log('[Tier 0.5 Playlist] No active YouTube tab');
          return resolve(null);
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PLAYLIST_VIDEOS_FROM_DOM', playlistId }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Tier 0.5 Playlist] Runtime error:', chrome.runtime.lastError.message);
            return resolve(null);
          }

          if (!response?.success) {
            if (response?.logs) {
              console.log('[Tier 0.5 Playlist] Logs:', response.logs);
            }
            console.log('[Tier 0.5 Playlist] Failed:', response?.error || 'Unknown error');
            return resolve(null);
          }

          console.log(`[Tier 0.5 Playlist] Success: ${response.videos?.length || 0} videos, title: ${response.title}`);
          resolve({
            videos: response.videos || [],
            title: response.title || ''
          });
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TIER 0.5 Auth: Credentialed Playlist Page Fetch
  // Used as final fallback for private playlists (e.g. LL) where
  // all unauthenticated API clients return "does not exist".
  // Requires an active YouTube tab so the content script can fetch
  // the playlist page with session cookies.
  // ─────────────────────────────────────────────────────────────
  async _fetchPlaylistPageAuth(playlistId) {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          console.log('[Tier 0.5 Auth] No YouTube tab found');
          return resolve(null);
        }

        // Prefer active tab, fall back to any YouTube tab
        const tab = tabs.find(t => t.active) || tabs[0];
        const timeout = setTimeout(() => {
          console.log('[Tier 0.5 Auth] Timeout');
          resolve(null);
        }, 10000);

        chrome.tabs.sendMessage(tab.id, { type: 'FETCH_PLAYLIST_PAGE', playlistId }, (response) => {
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            console.warn('[Tier 0.5 Auth] Runtime error:', chrome.runtime.lastError.message);
            return resolve(null);
          }

          if (!response?.success) {
            console.log('[Tier 0.5 Auth] Failed:', response?.error || 'Unknown error');
            return resolve(null);
          }

          console.log(`[Tier 0.5 Auth] Success: ${response.videos?.length || 0} videos, title: ${response.title}`);
          resolve({
            videos: response.videos || [],
            title: response.title || ''
          });
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TIER 0.5 Auth: Credentialed Transcript Fetch
  // Used as final fallback for batch playlist downloads when
  // API-only tiers fail with LOGIN_REQUIRED. Requires an active
  // YouTube tab so the content script can fetch the watch page
  // with session cookies and extract caption tracks.
  // ─────────────────────────────────────────────────────────────
  async _fetchTranscriptAuth(videoId, options = {}) {
    const { lang = 'auto', translate = false, translateLang = 'en' } = options;
    return new Promise((resolve) => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          console.log('[Tier 0.5 Auth Transcript] No YouTube tab found');
          return resolve(null);
        }

        const tab = tabs.find(t => t.active) || tabs[0];
        const timeout = setTimeout(() => {
          console.log('[Tier 0.5 Auth Transcript] Timeout');
          resolve(null);
        }, 20000);

        chrome.tabs.sendMessage(tab.id, {
          type: 'FETCH_TRANSCRIPT_AUTH',
          videoId,
          lang,
          translate,
          translateLang
        }, (response) => {
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            console.warn('[Tier 0.5 Auth Transcript] Runtime error:', chrome.runtime.lastError.message);
            return resolve(null);
          }

          if (!response?.success) {
            console.log('[Tier 0.5 Auth Transcript] Failed:', response?.error || 'Unknown error');
            if (response?.logs) {
              response.logs.forEach(l => console.log('[Content]', l));
            }
            return resolve(null);
          }

          if (response?.result && response.result.length > 0) {
            console.log(`[Tier 0.5 Auth Transcript] Success: ${response.result.length} segments from ${response.source || 'unknown'}`);
            resolve(response.result);
          } else {
            console.log('[Tier 0.5 Auth Transcript] Empty result');
            resolve(null);
          }
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // EMBED FRAME TRANSCRIPT SNIFFER
  // Injects a hidden embed iframe into an active YouTube tab where
  // the real YouTube player solves BotGuard and makes PoToken-authenticated
  // timedtext requests. Our sniffer (MAIN world, all_frames:true) captures
  // response bodies and relays them back via window.postMessage.
  // ─────────────────────────────────────────────────────────────
  async _fetchTranscriptViaEmbedFrame(videoId, options = {}) {
    const { lang = 'auto', timeout = 25000 } = options;
    return new Promise((resolve) => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          console.log('[EmbedFrame] No YouTube tab found');
          return resolve(null);
        }
        const tab = tabs.find(t => t.active) || tabs[0];
        const timer = setTimeout(() => {
          console.log('[EmbedFrame] Timeout');
          resolve(null);
        }, timeout);
        chrome.tabs.sendMessage(tab.id, {
          type: 'INJECT_EMBED_FRAME',
          videoId,
          lang: lang !== 'auto' ? lang : null,
          timeout: timeout - 5000
        }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            console.warn('[EmbedFrame] Runtime error:', chrome.runtime.lastError.message);
            return resolve(null);
          }
          if (!response?.success) {
            console.log('[EmbedFrame] Failed:', response?.error || 'Unknown error');
            if (response?.logs) response.logs.forEach(l => console.log('[Content]', l));
            return resolve(null);
          }
          if (response?.result && response.result.length > 0) {
            console.log(`[EmbedFrame] Success: ${response.result.length} segments`);
            resolve(response.result);
          } else {
            console.log('[EmbedFrame] Empty result');
            resolve(null);
          }
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // PLAYER COERCION (Pathway 1): Use native YT player
  // Calls player.loadVideoById() + loadModule("captions") to force
  // the real YouTube player to solve BotGuard and request timedtext.
  // Requires an active YouTube tab with a initialized player.
  // ─────────────────────────────────────────────────────────────
  async _coercePlayerTranscript(videoId, options = {}) {
    const { lang = 'auto', timeout = 30000 } = options;
    return new Promise((resolve) => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          console.log('[CoercePlayer] No YouTube tab found');
          return resolve(null);
        }
        const tab = tabs.find(t => t.active) || tabs[0];
        const timer = setTimeout(() => {
          console.log('[CoercePlayer] Timeout');
          resolve(null);
        }, timeout);
        chrome.tabs.sendMessage(tab.id, {
          type: 'COERCE_PLAYER_TRANSCRIPT',
          videoId,
          lang: lang !== 'auto' ? lang : null,
          timeout: timeout - 5000
        }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            console.warn('[CoercePlayer] Runtime error:', chrome.runtime.lastError.message);
            return resolve(null);
          }
          if (!response?.success) {
            console.log('[CoercePlayer] Failed:', response?.error || 'Unknown error');
            if (response?.logs) response.logs.forEach(l => console.log('[Content]', l));
            return resolve(null);
          }
          if (response?.result && response.result.length > 0) {
            console.log(`[CoercePlayer] Success: ${response.result.length} segments`);
            resolve(response.result);
          } else {
            console.log('[CoercePlayer] Empty result');
            resolve(null);
          }
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TAB NAVIGATION: Navigate tab to watch page, capture via sniffer
  // Navigates an active YouTube tab to the video's watch page.
  // The REAL YouTube player initializes, solves BotGuard, and requests
  // timedtext with a valid PoToken. The sniffer captures the response.
  // After extraction, navigates back to the original URL.
  // ─────────────────────────────────────────────────────────────
  async _fetchTranscriptViaTabNav(videoId, options = {}) {
    const { timeout = 30000 } = options;
    // Serialize via lock to prevent concurrent tab navigations
    return new Promise((resolve) => {
      this._tabNavLock = this._tabNavLock.then(() => new Promise((innerResolve) => {
        const passThrough = (result) => {
          resolve(result);
          innerResolve(result);
        };
        chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          console.log('[TabNav] No YouTube tab found');
          return passThrough(null);
        }

        const tab = tabs.find(t => t.active) || tabs[0];
        const originalUrl = tab.url;

        // Preserve playlist context by extracting list param from original URL
        let watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        try {
          const origUrlObj = new URL(originalUrl);
          const listParam = origUrlObj.searchParams.get('list');
          if (listParam) {
            watchUrl += `&list=${listParam}`;
          }
        } catch (e) {
          // Invalid URL, just use bare watch URL
        }

        // Save original URL on first navigation so we can restore it after batch
        if (!this._originalTabUrl) {
          this._originalTabUrl = originalUrl;
        }

        console.log(`[TabNav] Navigating tab ${tab.id} from ${originalUrl} to ${watchUrl}`);

        let resolved = false;
        let pollTimer = null;
        let timeoutTimer = null;

        const cleanup = () => {
          resolved = true;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
          chrome.tabs.onUpdated.removeListener(onUpdated);
        };

        timeoutTimer = setTimeout(() => {
          if (resolved) { cleanup(); return; }
          resolved = true;
          console.log('[TabNav] Timeout');
          cleanup();
          passThrough(null);
        }, timeout);

        const startPolling = () => {
          pollTimer = setInterval(() => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'POLL_TRANSCRIPT',
              videoId
            }, (response) => {
              if (chrome.runtime.lastError) return;
              if (response?.success && response?.result?.length > 0) {
                console.log(`[TabNav] Got ${response.result.length} segments`);
                resolved = true;
                cleanup();
                passThrough(response.result);
              }
            });
          }, 800);
        };

        const onUpdated = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            setTimeout(() => {
              if (!resolved) startPolling();
            }, 3000);
          }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.update(tab.id, { url: watchUrl });
      });   // chrome.tabs.query
    }));    // inner promise + _tabNavLock.then()
  });       // outer promise
}

  // ─────────────────────────────────────────────────────────────
  // RESTORE ORIGINAL TAB (after batch navigation is done)
  // ─────────────────────────────────────────────────────────────
  async restoreOriginalTab() {
    const originalUrl = this._originalTabUrl;
    this._originalTabUrl = null;
    if (!originalUrl) return;

    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
      if (tabs.length === 0) return;
      const tab = tabs.find(t => t.active) || tabs[0];
      if (tab.url && tab.url.includes('/watch')) {
        console.log(`[TabNav] Restoring original URL: ${originalUrl}`);
        await chrome.tabs.update(tab.id, { url: originalUrl });
      }
    } catch (e) {
      console.warn('[TabNav] Failed to restore tab:', e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  async _getCapturedUrl(videoId, lang) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve(null);
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CAPTURED_URL', videoId, lang }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Tier 0] Runtime error:', chrome.runtime.lastError.message);
            return resolve(null);
          }
          
          if (response?.success && response.url) {
            console.log(`[Tier 0] Found captured URL for ${videoId}`);
            resolve(response.url);
          } else {
            resolve(null);
          }
        });
      });
    });
  }

  // Get baseUrl from Player API for download
  async _getTrackUrlFromPlayer(videoId, lang) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve(null);
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PLAYER_TRACKS', videoId }, (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            return resolve(null);
          }
          
          const tracks = response.tracks || [];
          let track;
          
          if (lang && lang !== 'auto') {
            track = tracks.find(t => t.languageCode === lang);
          }
          
          if (!track) {
            track = tracks.find(t => t.languageCode === 'en') || tracks[0];
          }
          
          if (track?.baseUrl) {
            console.log(`[Tier 0.5] Got track URL for lang=${track.languageCode}`);
            resolve(track.baseUrl);
          } else {
            resolve(null);
          }
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // FORCE CC TRIGGER: Force caption toggle
  // ─────────────────────────────────────────────────────────────
  async _forceTriggerCaptions(cycles = 3, interval = 150, targetLang = null) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve(false);
        
        chrome.tabs.sendMessage(tabs[0].id, { 
          type: 'FORCE_CC_TRIGGER', 
          cycles, 
          interval,
          targetLang
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ForceCC] Runtime error:', chrome.runtime.lastError.message);
            return resolve(false);
          }
          
          if (response?.success) {
            console.log(`[ForceCC] Trigger completed successfully`);
          }
          resolve(response?.success || false);
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN WORLD FETCHER: Fetch via MAIN world context
  // ─────────────────────────────────────────────────────────────
  async _fetchViaMainWorld(url, timeout = 10000) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve({ success: false, error: 'No active YouTube tab' });
        
        chrome.tabs.sendMessage(tabs[0].id, { 
          type: 'MAIN_WORLD_FETCH', 
          url,
          timeout
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[MainWorldFetch] Runtime error:', chrome.runtime.lastError.message);
            return resolve({ success: false, error: chrome.runtime.lastError.message });
          }
          resolve(response || { success: false, error: 'No response' });
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Get Video Metadata (Languages + Title)
  // ─────────────────────────────────────────────────────────────
  async getMetadata(videoId) {
    const cacheKey = `metadata:${videoId}`;
    if (this.cache.has(cacheKey)) {
      console.log(`[TranslationManager] Metadata cache hit for ${videoId}`);
      return this.cache.get(cacheKey);
    }

    // DEDUPLICATION: Check if there's already a pending request for this video
    if (this.pendingMetadataRequests.has(videoId)) {
      console.log(`[TranslationManager] Metadata request deduplication for ${videoId}`);
      return this.pendingMetadataRequests.get(videoId);
    }

    console.log(`[TranslationManager] Metadata cache miss for ${videoId}, fetching...`);

    // Create the promise for this request
    const requestPromise = this._fetchMetadataInternal(videoId, cacheKey);

    // Store in pending map
    this.pendingMetadataRequests.set(videoId, requestPromise);

    // Clean up pending map when done (success or error)
    requestPromise.finally(() => {
      this.pendingMetadataRequests.delete(videoId);
    });

    return requestPromise;
  }

  /**
   * Internal metadata fetch implementation (separated for deduplication)
   */
  async _fetchMetadataInternal(videoId, cacheKey) {
    // Check cache again in case it was populated while we were waiting
    if (this.cache.has(cacheKey)) {
      console.log(`[TranslationManager] Metadata cache hit (late) for ${videoId}`);
      return this.cache.get(cacheKey);
    }

    // Phase 1: Try cheap tiers first (0.5 and 1.5) - these are fast and don't require API calls
    console.log('[TranslationManager] Starting cheap tier batch: 0.5, 1.5');
    const cheapResults = await Promise.allSettled([
      this._getLanguagesTier0_5(videoId),
      this._getLanguagesTier1_5(videoId)
    ]);

    const [tier05Result, tier15Result] = cheapResults;

    // Tier 0.5: Player API (first priority - instant from active player)
    if (tier05Result.status === 'fulfilled') {
      const result = tier05Result.value;
      if (result.languages && result.languages.length > 0) {
        console.log(`[TranslationManager] Tier 0.5 success: ${result.languages.length} languages`);
        const metadata = {
          title: result.title || 'YouTube Video',
          languages: result.languages
        };
        this._setCache(cacheKey, metadata);
        return metadata;
      }
    } else {
      console.warn('Tier 0.5 Metadata failed:', tier05Result.reason?.message || tier05Result.reason);
    }

    // Tier 1.5: Embed Page (second priority - slow but works for age-restricted)
    if (tier15Result.status === 'fulfilled') {
      const result = tier15Result.value;
      if (result.languages && result.languages.length > 0) {
        console.log(`[TranslationManager] Tier 1.5 success: ${result.languages.length} languages`);
        const metadata = {
          title: result.title || 'YouTube Video',
          languages: result.languages
        };
        this._setCache(cacheKey, metadata);
        return metadata;
      }
    } else {
      console.warn('Tier 1.5 Metadata failed:', tier15Result.reason?.message || tier15Result.reason);
    }

    // Phase 2: Try API tier only if cheap tiers failed
    console.log('[TranslationManager] Cheap tiers failed, trying Tier 1 (API)...');
    try {
      const { languages, title } = await getLanguages(videoId);
      const tier1Result = {
        languages: languages?.map(l => ({
          code: l.languageCode,
          name: l.languageName,
          isAuto: l.kind === 'asr'
        })) || [],
        title: title || 'YouTube Video'
      };

      if (tier1Result.languages.length > 0) {
        console.log(`[TranslationManager] Tier 1 success: ${tier1Result.languages.length} languages`);
        this._setCache(cacheKey, tier1Result);
        return tier1Result;
      }
      console.warn('Tier 1 Metadata returned no languages');
    } catch (tier1Err) {
      console.warn('Tier 1 Metadata failed:', tier1Err?.message || tier1Err);
    }

    // Tier 3: Innertube (reliable, works without active tab)
    console.log('[TranslationManager] Trying Tier 3 (Innertube)...');
    try {
        const result = await getVideoMetadataTier3(videoId);
        if (result && result.languages && result.languages.length > 0) {
            console.log(`[TranslationManager] Tier 3 success: ${result.languages.length} languages`);
            this._setCache(cacheKey, result);
            return result;
        }
        console.warn('Tier 3 returned no languages, falling back...');
    } catch (e3) {
        console.warn('Tier 3 Metadata failed:', e3?.message || e3);
    }

    // Tier 2: Page context (requires active YouTube tab)
    console.log('[TranslationManager] Trying Tier 2 (Page Context)...');
    try {
        const tier2Result = await this._getLanguagesTier2(videoId);
        if (tier2Result && tier2Result.length > 0) {
            // Try to get title from page context
            let title = 'YouTube Video';
            try {
                const pageTitle = await this._getPageTitle(videoId);
                if (pageTitle) title = pageTitle;
            } catch (e) {
                console.log('[Tier 2] Could not get page title:', e.message);
            }
            const result = {
                title: title,
                languages: tier2Result
            };
            this._setCache(cacheKey, result);
            return result;
        }
    } catch (e2) {
        console.warn('Tier 2 Metadata failed:', e2?.message || e2);
    }

    // Tier 4 (Page Context / Age Restricted Fallback)
    console.log('[TranslationManager] Trying Tier 4...');
    try {
        console.log('[TranslationManager] Attempting Tier 4 (Page Context)...');
        const result = await this._getLanguagesTier4(videoId);
        if (result && result.languages.length > 0) {
             const meta = {
                title: result.title || 'YouTube Video',
                languages: result.languages
             };
             this._setCache(cacheKey, meta);
             return meta;
        }
    } catch (e4) {
        console.error('Tier 4 Metadata failed:', e4);
    }

    throw new Error('All metadata tiers failed');
  }



  async _getLanguagesTier1(videoId) {
      try {
          const { languages } = await getLanguages(videoId);
          if (!languages) return [];
          
          return languages.map(l => ({
              code: l.languageCode,
              name: l.languageName,
              isAuto: l.kind === 'asr'
          }));
      } catch (e) {
          console.error('[Tier 1] Failed to get languages:', e);
          return [];
      }
  }

  // ─────────────────────────────────────────────────────────────
  // TIER 1.5: Embed Page Extraction (Guest Mode / Age-Restricted Bypass)
  // ─────────────────────────────────────────────────────────────
  async _getLanguagesTier1_5(videoId) {
    try {
      console.log('[Tier 1.5] Attempting Embed page extraction...');

      // Add timeout to prevent hanging for 10+ seconds (covers fetch + body reading)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      let response;
      let html;
      try {
        response = await fetch(`https://www.youtube.com/embed/${videoId}`, {
          signal: controller.signal
        });

        console.log(`[Tier 1.5] Fetch status: ${response.status}`);

        if (!response.ok) {
          throw new Error(`Embed page fetch failed: ${response.status}`);
        }

        html = await response.text();
      } finally {
        clearTimeout(timeoutId);
      }
      console.log(`[Tier 1.5] HTML length: ${html.length}`);
      
      // Method 1: Look for ytcfg.set({ ... })
      const ytcfgMatch = html.match(/ytcfg\.set\(({.+?})\);/s);
      if (ytcfgMatch) {
        try {
          const config = JSON.parse(ytcfgMatch[1]);
          const playerResponse = config.PLAYER_VARS?.embedded_player_response;
          
          if (playerResponse) {
            const data = typeof playerResponse === 'string' 
              ? JSON.parse(playerResponse) 
              : playerResponse;
            
            const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            
            if (tracks && tracks.length > 0) {
              const languages = tracks.map(t => ({
                code: t.languageCode,
                name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
                isAuto: t.kind === 'asr'
              }));
              
              const title = data.videoDetails?.title || 'YouTube Video';
              console.log(`[Tier 1.5] Success via ytcfg! Found ${languages.length} languages`);
              return { languages, title };
            }
          }
        } catch (parseErr) {
          console.warn('[Tier 1.5] ytcfg parse failed:', parseErr.message);
        }
      }
      
      // Method 2: Look for ytInitialPlayerResponse in script
      const scriptMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
      if (scriptMatch) {
        try {
          const playerResponse = JSON.parse(scriptMatch[1]);
          const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          
          if (tracks && tracks.length > 0) {
            const languages = tracks.map(t => ({
              code: t.languageCode,
              name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
              isAuto: t.kind === 'asr'
            }));
            
            const title = playerResponse.videoDetails?.title || 'YouTube Video';
            console.log(`[Tier 1.5] Success via script! Found ${languages.length} languages`);
            return { languages, title };
          }
        } catch (parseErr) {
          console.warn('[Tier 1.5] script parse failed:', parseErr.message);
        }
      }
      
      // Method 3: Look for yt.setConfig
      const setConfigMatch = html.match(/yt\.setConfig\(\s*{\s*PLAYER_VARS:\s*({.+?})\s*}\s*\)/s);
      if (setConfigMatch) {
        try {
          const playerVars = JSON.parse(setConfigMatch[1]);
          const embeddedResponse = playerVars.embedded_player_response;
          
          if (embeddedResponse) {
            const data = typeof embeddedResponse === 'string'
              ? JSON.parse(embeddedResponse)
              : embeddedResponse;
            
            const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            
            if (tracks && tracks.length > 0) {
              const languages = tracks.map(t => ({
                code: t.languageCode,
                name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
                isAuto: t.kind === 'asr'
              }));
              
              console.log(`[Tier 1.5] Success via yt.setConfig! Found ${languages.length} languages`);
              return { languages, title: data.videoDetails?.title || 'YouTube Video' };
            }
          }
        } catch (parseErr) {
          console.warn('[Tier 1.5] yt.setConfig parse failed:', parseErr.message);
        }
      }
      
      console.log('[Tier 1.5] No captions found in embed page');
      return { languages: [], title: null };
      
    } catch (err) {
      console.error('[Tier 1.5] Embed extraction failed:', err.message);
      return { languages: [], title: null };
    }
  }

  // Extract transcript from embed page
  async _extractFromEmbed(videoId, lang, translate, targetLang) {
    try {
      console.log('[Tier 1.5] Extracting transcript from embed page...');

      // Add timeout to prevent hanging (covers fetch + body reading)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      let response;
      let html;
      try {
        response = await fetch(`https://www.youtube.com/embed/${videoId}`, {
          signal: controller.signal
        });

        html = await response.text();
      } finally {
        clearTimeout(timeoutId);
      }
      
      // Find caption track URL from embed page
      const scriptMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
      let playerResponse;
      
      if (scriptMatch) {
        playerResponse = JSON.parse(scriptMatch[1]);
      } else {
        // Try ytcfg
        const ytcfgMatch = html.match(/ytcfg\.set\(({.+?})\);/s);
        if (ytcfgMatch) {
          const config = JSON.parse(ytcfgMatch[1]);
          const embeddedResponse = config.PLAYER_VARS?.embedded_player_response;
          playerResponse = typeof embeddedResponse === 'string' 
            ? JSON.parse(embeddedResponse) 
            : embeddedResponse;
        }
      }
      
      if (!playerResponse) {
        throw new Error('No player response in embed page');
      }
      
      const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      
      if (!tracks || tracks.length === 0) {
        throw new Error('No caption tracks in embed page');
      }
      
      // Select track
      let track;
      if (lang && lang !== 'auto') {
        track = tracks.find(t => t.languageCode === lang);
      }
      if (!track) {
        track = tracks.find(t => t.languageCode === 'en') || tracks[0];
      }
      
      if (!track?.baseUrl) {
        throw new Error('No valid track URL found');
      }
      
      // Build fetch URL
      let fetchUrl = track.baseUrl;
      // Remove any existing tlang to avoid duplicates using URL API
      if (fetchUrl.includes('tlang=')) {
        try {
          const url = new URL(fetchUrl);
          url.searchParams.delete('tlang');
          fetchUrl = url.toString();
        } catch (e) {
          console.warn('[Tier 1.5] Invalid URL for tlang removal, using regex fallback:', e.message);
          fetchUrl = fetchUrl.replace(/([?&])tlang=[^&]*(&?)/g, (m, p, s) => (p === '?' && s) ? '?' : '');
          fetchUrl = fetchUrl.replace(/\?&/, '?').replace(/&$/, '');
        }
      }
      if (translate && targetLang) {
        try {
          const url = new URL(fetchUrl);
          url.searchParams.set('tlang', targetLang);
          fetchUrl = url.toString();
        } catch (e) {
          console.warn('[Tier 1.5] Invalid URL for tlang addition, using concat fallback:', e.message);
          if (!fetchUrl.includes('tlang=')) {
            fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + `tlang=${targetLang}`;
          }
        }
      }
      if (!fetchUrl.includes('fmt=')) {
        fetchUrl += '&fmt=json3';
      }
      
      // Fetch transcript
      const transcriptResponse = await fetch(fetchUrl);
      const text = await transcriptResponse.text();
      
      if (!text || text.trim().length === 0) {
        throw new Error('Empty transcript response');
      }
      
      // Parse JSON3
      const json = JSON.parse(text);
      if (!json.events) {
        throw new Error('Invalid JSON3 format');
      }
      
      const segments = json.events
        .filter(e => e.segs)
        .map(e => ({
          start: (e.tStartMs || 0) / 1000,
          duration: (e.dDurationMs || 0) / 1000,
          text: e.segs.map(s => s.utf8 || '').join('')
        }))
        .filter(e => e.text.trim().length > 0);
      
      console.log(`[Tier 1.5] Success! ${segments.length} segments`);
      return segments;
      
    } catch (err) {
      console.error('[Tier 1.5] Transcript extraction failed:', err.message);
      throw err;
    }
  }

  async _getLanguagesTier2(videoId) {
    return new Promise((resolve, reject) => {
      // Timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error('Tier 2 timeout - no response from content script'));
      }, 3000);

      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          clearTimeout(timeout);
          return reject(new Error('Tier 2: No active YouTube tab found'));
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_TIER2_LANGUAGES', videoId }, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            return reject(new Error(`Tier 2 communication error: ${chrome.runtime.lastError.message}`));
          }
          if (!response?.success) {
            return reject(new Error('Tier 2: Content script returned no success'));
          }
          // Also capture title if returned
          if (response.title) {
            this._cachedTitle = response.title;
          }
          if (!response.languages || response.languages.length === 0) {
            return reject(new Error('Tier 2: No languages found'));
          }
          resolve(response.languages);
        });
      });
    });
  }

  // Helper to get page title
  async _getPageTitle(videoId) {
    // First check if we got title from Tier 2
    if (this._cachedTitle) {
      return this._cachedTitle;
    }
    
    // Try to get from page context
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve(null);
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_TITLE', videoId }, (response) => {
          if (response?.success && response.title) {
            resolve(response.title);
          } else {
            resolve(null);
          }
        });
      });
    });
  }

  async _getLanguagesTier4(videoId) {
    return new Promise((resolve, reject) => {
      // Timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error('Tier 4 timeout - no response from content script'));
      }, 5000);

      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          clearTimeout(timeout);
          return reject(new Error('Tier 4: No active YouTube tab found'));
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_CONTEXT_LANGUAGES', videoId }, (response) => {
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            return reject(new Error(`Tier 4 runtime error: ${chrome.runtime.lastError.message}`));
          }

          if (response?.logs) {
            console.groupCollapsed('[Tier 4] Page Context Logs');
            response.logs.forEach(l => console.log(l));
            console.groupEnd();
          }

          if (!response?.success) {
            return reject(new Error(`Tier 4 failed: ${response?.error || 'Unknown error'}`));
          }

          if (!response.languages || response.languages.length === 0) {
            return reject(new Error('Tier 4: No languages found'));
          }

          resolve(response);
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Extraction with Translation (Universal Interface)
  // ─────────────────────────────────────────────────────────────
  async extractWithTranslation(videoId, options = {}) {
    const {
      sourceLang = 'auto',
      targetLang = 'ru',
      translate = false,
      preferTier = 1
    } = options;

    const cacheKey = `transcript:${videoId}:${sourceLang}:${translate}:${translate ? targetLang : ''}`;
    if (this.cache.has(cacheKey)) {
        console.log(`[TranslationManager] Transcript cache hit for ${cacheKey}`);
        const cached = this.cache.get(cacheKey);
        return {
            ...cached,
            logs: [...(cached.logs || []), `[Cache] Retrieved from cache`]
        };
    }

    // DEDUPLICATION: Check if there's already a pending request for this exact configuration
    const pendingKey = cacheKey; // Same as cache key for consistency
    if (this.pendingTranscriptRequests.has(pendingKey)) {
        console.log(`[TranslationManager] Transcript request deduplication for ${pendingKey}`);
        return this.pendingTranscriptRequests.get(pendingKey);
    }

    // Create the promise for this request
    const requestPromise = this._extractWithTranslationInternal(videoId, options, cacheKey);

    // Store in pending map
    this.pendingTranscriptRequests.set(pendingKey, requestPromise);

    // Clean up pending map when done (success or error)
    requestPromise.finally(() => {
        this.pendingTranscriptRequests.delete(pendingKey);
    });

    return requestPromise;
  }

  /**
   * Internal transcript extraction implementation (separated for deduplication)
   */
  async _extractWithTranslationInternal(videoId, options, cacheKey) {
    const {
      sourceLang = 'auto',
      targetLang = 'ru',
      translate = false,
      preferTier = 1
    } = options;

    // Check cache again in case it was populated while we were waiting
    if (this.cache.has(cacheKey)) {
        console.log(`[TranslationManager] Transcript cache hit (late) for ${cacheKey}`);
        const cached = this.cache.get(cacheKey);
        return {
            ...cached,
            logs: [...(cached.logs || []), `[Cache] Retrieved from cache (late)`]
        };
    }

    const errors = [];
    const logs = [];
    const log = (msg) => {
        console.log(msg);
        logs.push(msg);
    }

    // === FORCE CC TRIGGER (BEFORE Tier 0) ===
    // If no captured URLs, trigger captions to generate network requests
    try {
        log('[ForceCC] Checking for captured URLs...');
        const capturedUrl = await this._getCapturedUrl(videoId, sourceLang);
        
        if (!capturedUrl) {
            log('[ForceCC] No captured URL found. Triggering captions...');
            const triggered = await this._forceTriggerCaptions(3, 150, sourceLang);
            
            if (triggered) {
                log('[ForceCC] Captions triggered. Waiting for network requests...');
                // Wait a bit for requests to complete
                await new Promise(r => setTimeout(r, 500));
            }
        } else {
            log('[ForceCC] Already have captured URL, skipping trigger');
        }
    } catch (err) {
        log(`[ForceCC] Trigger failed: ${err.message}`);
    }

    // === TIER 0: Network Sniffer ===
    try {
        log('[Tier 0] Checking for captured URL...');
        const capturedUrl = await this._getCapturedUrl(videoId, sourceLang);
        
        if (capturedUrl) {
            log(`[Tier 0] Found captured URL: ${capturedUrl.substring(0, 100)}...`);
            
            // Add translation params if needed
            let fetchUrl = capturedUrl;
            
            // Remove any existing tlang parameter - we want original language, not translation
            if (fetchUrl.includes('tlang=')) {
                log('[Tier 0] Removing existing tlang parameter to get original language');
                try {
                    const url = new URL(fetchUrl);
                    url.searchParams.delete('tlang');
                    fetchUrl = url.toString();
                } catch (e) {
                    log('[Tier 0] Invalid URL for tlang removal, using regex fallback');
                    fetchUrl = fetchUrl.replace(/([?&])tlang=[^&]*(&?)/g, (m, p, s) => (p === '?' && s) ? '?' : '');
                    fetchUrl = fetchUrl.replace(/\?&/, '?').replace(/&$/, '');
                }
            }
            
            if (translate && targetLang && !fetchUrl.includes('tlang=')) {
                try {
                    const url = new URL(fetchUrl);
                    url.searchParams.set('tlang', targetLang);
                    fetchUrl = url.toString();
                } catch (e) {
                    log('[Tier 0] Invalid URL for tlang addition, using concat fallback');
                    fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + `tlang=${targetLang}`;
                }
            }
            
            // Format URL for JSON3
            if (!fetchUrl.includes('fmt=')) {
                fetchUrl += '&fmt=json3';
            } else {
                fetchUrl = fetchUrl.replace(/fmt=[^&]+/, 'fmt=json3');
            }
            
            const response = await fetch(fetchUrl);
            if (response.ok) {
                const text = await response.text();
                if (text && text.trim().length > 0) {
                    try {
                        const json = JSON.parse(text);
                        if (json.events) {
                            const result = json.events
                                .filter(e => e.segs)
                                .map(e => ({
                                    start: (e.tStartMs || 0) / 1000,
                                    duration: (e.dDurationMs || 0) / 1000,
                                    text: e.segs.map(s => s.utf8 || '').join('')
                                }))
                                .filter(e => e.text.trim().length > 0);
                            
                            if (result.length > 0) {
                                log(`[Tier 0] Success! ${result.length} segments from sniffer`);
                                // Debug: show first few segments to verify language
                                const firstFew = result.slice(0, 3).map(s => s.text?.substring(0, 50)).join(' | ');
                                log(`[Tier 0] First segments: ${firstFew}`);
                                const resp = {
                                    source: 'tier0-sniffer',
                                    result,
                                    translated: translate,
                                    sourceLang,
                                    targetLang,
                                    logs
                                };
                                this._setCache(cacheKey, resp);
                                return resp;
                            }
                        }
                    } catch (parseErr) {
                        log(`[Tier 0] JSON parse failed: ${parseErr.message}`);
                    }
                }
            }
            log('[Tier 0] Captured URL fetch failed, falling back...');
        } else {
            log('[Tier 0] No captured URL found');
        }
    } catch (err) {
        errors.push({ tier: 0, error: err.message });
        log(`[Tier 0] Failed: ${err.message}`);
    }

    // === TIER 0.5: Player API URL ===
    try {
        log('[Tier 0.5] Getting URL from Player API...');
        const trackUrl = await this._getTrackUrlFromPlayer(videoId, sourceLang);
        
        if (trackUrl) {
            log(`[Tier 0.5] Got track URL: ${trackUrl.substring(0, 100)}...`);
            
            let fetchUrl = trackUrl;
            if (translate && targetLang && !trackUrl.includes('tlang=')) {
                try {
                    const url = new URL(fetchUrl);
                    url.searchParams.set('tlang', targetLang);
                    fetchUrl = url.toString();
                } catch (e) {
                    log('[Tier 0.5] Invalid URL for tlang addition, using concat fallback');
                    fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + `tlang=${targetLang}`;
                }
            }
            
            if (!fetchUrl.includes('fmt=')) {
                fetchUrl += '&fmt=json3';
            } else {
                fetchUrl = fetchUrl.replace(/fmt=[^&]+/, 'fmt=json3');
            }
            
            const response = await fetch(fetchUrl);
            if (response.ok) {
                const text = await response.text();
                if (text && text.trim().length > 0) {
                    try {
                        const json = JSON.parse(text);
                        if (json.events) {
                            const result = json.events
                                .filter(e => e.segs)
                                .map(e => ({
                                    start: (e.tStartMs || 0) / 1000,
                                    duration: (e.dDurationMs || 0) / 1000,
                                    text: e.segs.map(s => s.utf8 || '').join('')
                                }))
                                .filter(e => e.text.trim().length > 0);
                            
                            if (result.length > 0) {
                                log(`[Tier 0.5] Success! ${result.length} segments from Player API`);
                                const resp = {
                                    source: 'tier0.5-player',
                                    result,
                                    translated: translate,
                                    sourceLang,
                                    targetLang,
                                    logs
                                };
                                this._setCache(cacheKey, resp);
                                return resp;
                            }
                        }
                    } catch (parseErr) {
                        log(`[Tier 0.5] JSON parse failed: ${parseErr.message}`);
                    }
                }
            }
            log('[Tier 0.5] Player API URL fetch failed, falling back...');
        } else {
            log('[Tier 0.5] No track URL from Player API');
        }
    } catch (err) {
        errors.push({ tier: '0.5', error: err.message });
        log(`[Tier 0.5] Failed: ${err.message}`);
    }

    // === TIER 1 ===
    if (preferTier <= 1) {
      try {
        log(`[Tier 1] Attempting${translate ? ' (with translation)' : ''}...`);
        
        const result = await getSubtitles({
          videoID: videoId,
          lang: sourceLang !== 'auto' ? sourceLang : 'en',
          translate: translate,
          translateLang: translate ? targetLang : undefined
        });

        if (result && result.length > 0) {
          log('[Tier 1] Success!');
          const response = { 
            source: 'tier1', 
            result, 
            translated: translate,
            sourceLang,
            targetLang,
            logs
          };
          this._setCache(cacheKey, response);
          return response;
        }
      } catch (err) {
        errors.push({ tier: 1, error: err.message });
        log(`[Tier 1] Failed: ${err.message}`);
      }
    }

    // === TIER 1.5: Embed Page (Age-Restricted Bypass) ===
    try {
      log('[Tier 1.5] Attempting Embed page extraction...');
      
      const result = await this._extractFromEmbed(videoId, sourceLang, translate, targetLang);
      
      if (result && result.length > 0) {
        log('[Tier 1.5] Success!');
        const response = { 
          source: 'tier1.5-embed', 
          result, 
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: '1.5', error: err.message });
      log(`[Tier 1.5] Failed: ${err.message}`);
    }

    // === TIER 2 ===
    if (preferTier <= 2) {
      try {
        log(`[Tier 2] Attempting${translate ? ' (with translation)' : ''}...`);
        
        const result = await new Promise((resolve, reject) => {
             chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
                if (tabs.length === 0) return reject(new Error('No active YouTube tab'));
                
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'FETCH_TIER2_TRANSCRIPT',
                    videoId,
                    lang: sourceLang,
                    translate,
                    translateLang: targetLang
                }, (response) => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                    if (response?.success) resolve(response.result);
                    else reject(new Error(response?.error || 'Unknown error'));
                });
             });
        });

        if (result && result.length > 0) {
             log('[Tier 2] Success!');
             const response = { 
                source: 'tier2', 
                result, 
                translated: translate,
                sourceLang,
                targetLang,
                logs
             };
             this._setCache(cacheKey, response);
             return response;
        }
      } catch (err) {
        errors.push({ tier: 2, error: err.message });
        log(`[Tier 2] Failed: ${err.message}`);
      }
    }

    // === TIER 3 (YouTube Native Translation) ===
    try {
      log(`[Tier 3] Attempting YouTube Native (Content Script -> Background Fetch)${translate ? ' (with translation)' : ''}...`);
      
      const fetchNative = async (forceRefresh = false) => {
          return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Tier 3 Native timeout (5000ms)'));
            }, 5000);

            chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
              if (tabs.length === 0) {
                clearTimeout(timeoutId);
                reject(new Error('Open YouTube in browser'));
                return;
              }

              chrome.tabs.sendMessage(tabs[0].id, { 
                type: 'GET_BEST_CAPTION_URL', 
                videoId,
                sourceLang,
                targetLang,
                translate,
                forceRefresh
              }, async (response) => {
                clearTimeout(timeoutId);
                
                if (chrome.runtime.lastError) {
                     reject(new Error(chrome.runtime.lastError.message));
                     return;
                }

                if (response?.success) {
                  const { url, logs: contentLogs } = response;
                  if (contentLogs) contentLogs.forEach(l => log(l));
                  
                  try {
                      log(`[Background] Fetching URL: ${url}`);
                      const fetchRes = await fetch(url);
                      
                      if (!fetchRes.ok) {
                          throw new Error(`Fetch failed: ${fetchRes.status}`);
                      }

                      const text = await fetchRes.text();
                      if (!text || text.trim().length === 0) {
                           throw new Error('Empty response body');
                      }
                      
                      // Parse JSON3
                      let jsonData;
                      try {
                          jsonData = JSON.parse(text);
                      } catch (e) {
                           throw new Error('Failed to parse JSON3 response');
                      }
                      
                      const events = jsonData.events;
                      if (!events) throw new Error('Invalid JSON3 format (no events)');
                      
                      const result = events
                          .filter(e => e.segs)
                          .map(e => ({
                              start: (e.tStartMs || 0) / 1000,
                              duration: (e.dDurationMs || 0) / 1000,
                              text: e.segs.map(s => s.utf8 || '').join('')
                          }))
                          .filter(e => e.text.trim().length > 0);
                          
                      resolve(result);
                  } catch (fetchErr) {
                      reject(fetchErr);
                  }

                } else {
                  if (response?.logs) {
                      response.logs.forEach(l => log(l));
                  }
                  const error = new Error(response?.error || 'Tier 3 failed');
                  error.logs = response?.logs;
                  reject(error);
                }
              });
            });
          });
      };

      let result;
      try {
          result = await fetchNative(false);
      } catch (e) {
          if (e.message.includes('Empty response body') || e.message.includes('Fetch failed')) {
              log(`[Tier 3] First attempt failed: ${e.message}. Retrying with force refresh...`);
              result = await fetchNative(true);
          } else {
              throw e;
          }
      }

      const response = { 
        source: 'tier3-native-bg', 
        result, 
        translated: translate, 
        sourceLang, 
        targetLang, 
        logs
      };
      this._setCache(cacheKey, response);
      return response;

    } catch (err) {
      errors.push({ tier: '3-native', error: err.message });
      log(`[Tier 3] Native Failed: ${err.message}`);
    }

    // === TIER 3 (Legacy Fallback - Innertube) ===
    try {
        log(`[Tier 3] Attempting Legacy (Innertube)${translate ? ' (with translation)' : ''}...`);
        
        const legacyOptions = {
            lang: sourceLang,
            translate: translate,
            targetLang: targetLang
        };
        
        const legacyResult = await fetchTier3Transcript(videoId, legacyOptions);
        
        if (legacyResult && legacyResult.segments && legacyResult.segments.length > 0) {
             log('[Tier 3] Legacy Success!');
             
             const normalized = legacyResult.segments.map(s => ({
                 start: s.start,
                 end: s.end,
                 text: s.text
             }));
             
             const response = {
                 source: 'tier3-legacy',
                 result: normalized,
                 translated: translate,
                 sourceLang: legacyResult.language || sourceLang,
                 targetLang: targetLang,
                 logs
             };
             this._setCache(cacheKey, response);
             return response;
        }
    } catch (err) {
        errors.push({ tier: '3-legacy', error: err.message });
        log(`[Tier 3] Legacy Failed: ${err.message}`);
    }

    // === TIER 4 (Page Context Injection) ===
    try {
        log(`[Tier 4] Attempting Page Context Injection${translate ? ' (with translation)' : ''}...`);
        
        const result = await new Promise((resolve, reject) => {
             chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
                if (tabs.length === 0) return reject(new Error('No active YouTube tab'));
                
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'FETCH_PAGE_CONTEXT_TRANSCRIPT',
                    videoId,
                    lang: sourceLang,
                    translate,
                    translateLang: targetLang
                }, async (response) => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                    
                    if (response?.logs) {
                        log('--- [Tier 4 Content Logs] ---');
                        response.logs.forEach(l => log(l));
                        log('-----------------------------');
                    }
                    
                    // Log the response object for debugging
                    log(`[Tier 4] Content Response: success=${response?.success}, url=${response?.url}, error=${response?.error}`);

                    if (response?.success) {
                        resolve(response.result);
                    } else if (response?.url) {
                         // Fallback: Content script failed to fetch (likely CORB/ORB), but found URL.
                         // Try fetching from Background (privileged context).
                         log(`[Tier 4] Content fetch failed. Fallback: Fetching URL from background: ${response.url}`);
                         
                         try {
                              let text = '';
                              let bgRes = await fetch(response.url, { credentials: 'include' });
                              text = await bgRes.text();
                              
                              log(`[Tier 4] Background Fetch Status: ${bgRes.status} ${bgRes.statusText}`);
                              log(`[Tier 4] Background Body Length: ${text.length}`);
                              
                              // === MAIN WORLD FETCHER FALLBACK ===
                              // If background fetch returned empty response, try Main World Fetcher
                              if (!text || text.trim().length === 0) {
                                  log(`[Tier 4] Background fetch returned empty body. Trying Main World Fetcher...`);
                                  
                                  const mwResult = await this._fetchViaMainWorld(response.url, 10000);
                                  
                                  if (mwResult.success && mwResult.body && mwResult.body.trim().length > 0) {
                                      log(`[Tier 4] Main World Fetcher success! Status: ${mwResult.status}, Length: ${mwResult.body.length}`);
                                      text = mwResult.body;
                                  } else {
                                      log(`[Tier 4] Main World Fetcher failed: ${mwResult.error || 'empty response'}`);
                                  }
                              }
                              
                              if (text.length > 0) {
                                 log(`[Tier 4] Body Preview: ${text.substring(0, 500)}`);
                              }

                              if (!text || text.trim().length === 0) {
                                  throw new Error('Background fetch returned empty body');
                              }
                             
                             let segments = [];
                             // Try JSON3 first if url has fmt=json3
                             if (response.url.includes('fmt=json3') || text.startsWith('{')) {
                                 try {
                                     const json = JSON.parse(text);
                                     if (json.events) {
                                         segments = json.events
                                            .filter(e => e.segs)
                                            .map(e => ({
                                                start: (e.tStartMs || 0) / 1000,
                                                duration: (e.dDurationMs || 0) / 1000,
                                                text: e.segs.map(s => s.utf8 || '').join('')
                                            }))
                                            .filter(e => e.text.trim().length > 0);
                                     }
                                 } catch (e) {
                                     log(`[Tier 4] Background JSON3 parse failed: ${e.message}`);
                                 }
                             }
                             
                             // If no segments from JSON3, try XML regex
                     if (segments.length === 0) {
                         const regex = /<text start="([\d.]+)" dur="([\d.]+)".*?>(.*?)<\/text>/g;
                         let match;
                         while ((match = regex.exec(text)) !== null) {
                             segments.push({
                                 start: parseFloat(match[1]),
                                 duration: parseFloat(match[2]),
                                 text: he.decode(match[3])
                             });
                         }
                     }
                     
                     // If XML/JSON3 failed, try VTT
                     if (segments.length === 0) {
                         log(`[Tier 4] XML/JSON3 empty. Trying VTT fallback...`);
                         let vttUrl = response.url;
                         if (vttUrl.includes('fmt=')) {
                            vttUrl = vttUrl.replace(/fmt=[^&]+/, 'fmt=vtt');
                         } else {
                            vttUrl += '&fmt=vtt';
                         }
                         
                         try {
                             log(`[Tier 4] Background Fetching VTT: ${vttUrl}`);
                             const vttRes = await fetch(vttUrl);
                             const vttText = await vttRes.text();
                             
                             if (vttText && vttText.includes('WEBVTT')) {
                                 const lines = vttText.split('\n');
                                 let currentStart = 0;
                                 let currentDur = 0;
                                 let currentText = [];
                                 
                                 for (let line of lines) {
                                     line = line.trim();
                                     if (!line || line === 'WEBVTT') continue;
                                     
                                     const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s-->\s(\d{2}:\d{2}:\d{2}\.\d{3})/);
                                     if (timeMatch) {
                                         if (currentText.length > 0) {
                                             segments.push({ start: currentStart, duration: currentDur, text: currentText.join(' ') });
                                             currentText = [];
                                         }
                                         const parseTime = (t) => {
                                             const parts = t.split(':');
                                             return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                                         };
                                         currentStart = parseTime(timeMatch[1]);
                                         currentDur = parseTime(timeMatch[2]) - currentStart;
                                     } else if (!line.match(/^\d+$/)) {
                                         currentText.push(line);
                                     }
                                 }
                                 if (currentText.length > 0) {
                                             segments.push({ start: currentStart, duration: currentDur, text: currentText.join(' ') });
                                 }
                                 log(`[Tier 4] VTT parsed ${segments.length} segments`);
                             }
                         } catch (vttErr) {
                             log(`[Tier 4] VTT fetch failed: ${vttErr.message}`);
                         }
                     }
                     
                     if (segments.length > 0) {
                                 log(`[Tier 4] Background fetch success: ${segments.length} segments`);
                                 resolve(segments);
                             } else {
                                 reject(new Error('Background fetch parsed 0 segments'));
                             }
                             
                         } catch (bgErr) {
                             log(`[Tier 4] Background fetch failed: ${bgErr.message}`);
                             reject(new Error(response?.error || 'Unknown error'));
                         }
                    } else {
                        reject(new Error(response?.error || 'Unknown error'));
                    }
                });
             });
        });

        if (result && result.length > 0) {
             log('[Tier 4] Success!');
             const response = { 
                source: 'tier4-page-context', 
                result, 
                translated: translate,
                sourceLang,
                targetLang,
                logs
             };
             this._setCache(cacheKey, response);
             return response;
        }
    } catch (err) {
        errors.push({ tier: 4, error: err.message });
        log(`[Tier 4] Failed: ${err.message}`);
    }

    const finalError = new Error(`All extraction tiers failed: ${JSON.stringify(errors)}`);
    finalError.logs = logs;
    throw finalError;
  }

  // ─────────────────────────────────────────────────────────────
  // API-Only Tiers for Playlist Processing
  // Optimized: Start with Tier 3 (youtubei.js) as primary - it's the only reliable method
  // Tier 0.5/1/1.5 are deprecated as they all fail with PoToken requirements
  // ─────────────────────────────────────────────────────────────
  async getTranscriptForPlaylist(videoId, options = {}) {
    const { 
      sourceLang = 'auto', 
      translate = false, 
      targetLang = 'en'
    } = options;

    const logs = [];
    const log = (msg) => {
      console.log(`[Playlist] ${msg}`);
      logs.push(`[Playlist] ${msg}`);
    };

    log(`Processing ${videoId} (optimized - Tier 3 primary)...`);
    log(`Source: ${sourceLang}, Translate: ${translate}, Target: ${targetLang}`);

    const cacheKey = `playlist:${videoId}:${sourceLang}:${translate}:${translate ? targetLang : ''}`;
    
    // Check cache
    if (this.cache.has(cacheKey)) {
      log('Cache hit');
      return this.cache.get(cacheKey);
    }

    const errors = [];

    // === TIER 0 (Primary): Android API Bypass ===
    // ANDROID client often works without PoToken for /get_transcript.
    // Uses player endpoint with ANDROID context to get params,
    // then calls get_transcript to bypass PoToken enforcement.
    try {
      log('[Tier 0] Attempting Android API bypass...');
      const androidResult = await getTranscriptViaAndroid(videoId, sourceLang, {
        translate,
        translateLang: targetLang
      });

      if (androidResult && androidResult.segments && androidResult.segments.length > 0) {
        log(`[Tier 0] Success! ${androidResult.segments.length} segments from ${androidResult.source}`);

        const response = {
          source: androidResult.source || 'tier0-android',
          result: androidResult.segments,
          translated: translate,
          sourceLang: androidResult.language || sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: 0, error: err.message });
      log(`[Tier 0] Failed: ${err.message}`);
    }

    // === TIER 0.1: /next Endpoint → Engagement Panel Transcript ===
    // Calls /youtubei/v1/next instead of /player to get engagement
    // panels, then extracts transcript via continuation token.
    // Different endpoint path may have different PoToken enforcement.
    try {
      log('[Tier 0.1] Attempting /next engagement panel transcript...');
      const nextResult = await getTranscriptViaNext(videoId, sourceLang, {
        translate,
        translateLang: targetLang
      });

      if (nextResult && nextResult.segments && nextResult.segments.length > 0) {
        log(`[Tier 0.1] Success! ${nextResult.segments.length} segments`);

        const response = {
          source: nextResult.source || 'tier0.1-next',
          result: nextResult.segments,
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: '0.1', error: err.message });
      log(`[Tier 0.1] Failed: ${err.message}`);
    }

    // === TIER 3 (Primary): youtubei.js - the only reliable method for playlists ===
    try {
      log('[Tier 3] Attempting Innertube (primary)...');
      
      const tier3Options = {
        lang: sourceLang,
        translate: translate,
        targetLang: targetLang
      };
      
      const tier3Result = await fetchTier3Transcript(videoId, tier3Options);
      
      if (tier3Result && tier3Result.segments && tier3Result.segments.length > 0) {
        log(`[Tier 3] Success! ${tier3Result.segments.length} segments`);
        
        const normalized = tier3Result.segments.map(s => ({
          start: s.start,
          duration: s.end - s.start,
          text: s.text
        }));
        
        const response = {
          source: 'tier3-playlist',
          result: normalized,
          translated: translate,
          sourceLang: tier3Result.language || sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: 3, error: err.message });
      log(`[Tier 3] Failed: ${err.message}`);
    }

    // === FALLBACK: Try Tier 1 (updated client chain: IOS -> MWEB -> WEB_EMBEDDED) ===
    // Only used if Tier 3 fails, for edge cases
    try {
      log('[Tier 1 Fallback] Attempting updated client chain...');
      
      const result = await getSubtitles({
        videoID: videoId,
        lang: sourceLang !== 'auto' ? sourceLang : 'en',
        translate: translate,
        translateLang: translate ? targetLang : undefined
      });

      if (result && result.length > 0) {
        const normalized = result.map(s => ({
          start: s.start,
          duration: s.duration,
          text: s.text
        }));
        
        log(`[Tier 1] Success! ${normalized.length} segments`);
        const response = {
          source: 'tier1-playlist',
          result: normalized,
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: 1, error: err.message });
      log(`[Tier 1] Failed: ${err.message}`);
    }

    // === LAST RESORT: Embed Page ===
    try {
      log('[Tier 1.5] Attempting embed page (last resort)...');
      const result = await this._extractFromEmbed(videoId, sourceLang, translate, targetLang);
      
      if (result && result.length > 0) {
        log(`[Tier 1.5] Success! ${result.length} segments`);
        const response = {
          source: 'tier1.5-playlist',
          result,
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: '1.5', error: err.message });
      log(`[Tier 1.5] Failed: ${err.message}`);
    }

    // === TIER 2C (Tab Navigation): Navigate to watch page ===
    // Navigates the active YouTube tab to the video's watch page.
    // The REAL player solves BotGuard and makes PoToken-authenticated
    // timedtext request. The sniffer captures the response body.
    // This is the only tier that reliably works for heavily restricted
    // videos. The tab briefly visits each video.
    try {
      log('[Tier 2C Tab Nav] Navigating tab to watch page...');
      const tabResult = await this._fetchTranscriptViaTabNav(videoId, {
        timeout: 30000
      });

      if (tabResult && tabResult.length > 0) {
        log(`[Tier 2C Tab Nav] Success! ${tabResult.length} segments`);
        const response = {
          source: 'tier2c-tab-nav',
          result: tabResult,
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: '2c-tab-nav', error: err.message });
      log(`[Tier 2C Tab Nav] Failed: ${err.message}`);
    }

    // === TIER 0.5 AUTH (last resort): Credentialed transcript fetch ===
    // Only works if user has a YouTube tab open (content script needs cookies).
    // Used when all API-only tiers fail with LOGIN_REQUIRED.
    try {
      log('[Tier 0.5 Auth] Attempting credentialed transcript fetch...');
      const authResult = await this._fetchTranscriptAuth(videoId, {
        lang: sourceLang,
        translate,
        translateLang: targetLang
      });

      if (authResult && authResult.length > 0) {
        log(`[Tier 0.5 Auth] Success! ${authResult.length} segments`);
        const response = {
          source: 'tier0.5-auth',
          result: authResult,
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
    } catch (err) {
      errors.push({ tier: '0.5-auth', error: err.message });
      log(`[Tier 0.5 Auth] Failed: ${err.message}`);
    }

    // All tiers failed
    const finalError = new Error(`All API-only tiers failed for ${videoId}`);
    finalError.logs = logs;
    finalError.errors = errors;
    throw finalError;
  }

  // ─────────────────────────────────────────────────────────────
  // Cache Clear
  // ─────────────────────────────────────────────────────────────
  clearCache() {
    this.cache.clear();
  }
}

// Singleton
export const translationManager = new TranslationManager();
