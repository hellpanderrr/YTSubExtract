
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

    // Page-leg lock: ONE lock for every operation that drives the batch's
    // pinned tab (Tier 1.5 embed inject, Tier 1.7 player coercion, Tier 2C
    // tab navigation). The previous pair (_coerceLock / _tabNavLock) let a
    // 1.7 loadVideoById race a 2C navigation on the same tab under
    // concurrency 3 — one shared tab gets one shared mutex.
    this._pageLegLock = Promise.resolve();

    // Original tab URL before tab navigation (used to restore after batch)
    this._originalTabUrl = null;

    // Batch-pinned driver tab: seedWatchPage records the tab the user was on
    // when they clicked Download, and every mutating page-leg (1.5 inject,
    // 1.7 coercion, 2C navigation, restore) drives THAT tab — never whichever
    // YouTube tab happens to be active when the call runs. Null outside batch.
    this._batchTabId = null;

    // Cooperative batch cancellation (Stop button). Checked before starting
    // page-leg tiers and while waiting on their locks/polls.
    this._batchCancelled = false;
  }

  /**
   * Queue one page-leg operation on the shared lock chain.
   * The trailing .catch is load-bearing: without it, a single executor that
   * throws before passThrough would leave _pageLegLock permanently rejected
   * and EVERY future page-leg would silently stall for the rest of the
   * service worker's life (round-3 review finding). The failed leg's own
   * caller still times out via its timer; the chain survives.
   */
  _enqueuePageLeg(fn) {
    this._pageLegLock = this._pageLegLock
      .then(fn)
      .catch((e) => {
        console.error('[PageLeg] page-leg threw — lock chain recovered:', e);
      });
  }

  // ─────────────────────────────────────────────────────────────
  // Resolve the tab for a MUTATING page-leg call.
  // Prefers the batch-pinned tab; falls back to active-or-first only when
  // no pin is set (single video) or the pinned tab was CLOSED mid-batch.
  // The pin is validated as a YouTube tab when it is set (batch start);
  // after that a URL mismatch is NOT released — the batch's own navigations
  // and transient url states (mid-nav, nocookie) must not drop the pin,
  // which would revert the whole batch to follow-the-focus behavior.
  // ─────────────────────────────────────────────────────────────
  _resolvePageLegTab() {
    return new Promise((resolve) => {
      // rePin: set only when we got here via PIN DEATH mid-batch — the
      // replacement must become the new pin, otherwise every later leg and
      // the final restore re-follow the user's focus (the original bug).
      const pickFallback = (tabs, rePin) => {
        const pick = tabs.length ? (tabs.find((t) => t.active) || tabs[0]) : null;
        if (pick && rePin) {
          this._batchTabId = pick.id;
          // Restore must return THIS tab to ITS OWN page — not dead tab's
          // URL (round-3 review: re-pin without re-capture navigates the
          // replacement tab to a playlist the user never had there).
          if (pick.url) this._originalTabUrl = pick.url;
          console.log(`[PageLeg] Re-pinned driver tab to ${pick.id} after pin death (restore target: ${this._originalTabUrl})`);
        }
        resolve(pick);
      };

      if (this._batchTabId == null) {
        chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => pickFallback(tabs, false));
        return;
      }
      const pinnedId = this._batchTabId;
      chrome.tabs.get(pinnedId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          console.log(`[PageLeg] Pinned tab ${pinnedId} gone (${chrome.runtime.lastError?.message || 'closed'}), re-resolving`);
          this._batchTabId = null;
          chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => pickFallback(tabs, true));
          return;
        }
        resolve(tab);
      });
    });
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

      // Clear transcripts for this video — and its batch entries
      // (playlist:<id>:<lang>:...): playlist-mode Reset sends no CLEAR_CACHE
      // at all, so this loop is the ONLY per-video clear path a batch cache
      // ever gets. The colon delimiter keeps the prefix match exact.
      for (const key of this.cache.keys()) {
        if (key.startsWith(`transcript:${videoId}`) ||
            key.startsWith(`playlist:${videoId}:`)) {
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
    const { lang = 'auto', timeout = 10000 } = options;
    return new Promise((resolve) => {
      // Embed-frame shares the page with Tier 1.7's coercion, so concurrent
      // batch workers would inject/remove the same fixed iframe id. Serialize
      // on the coercion lock — it is the same shared surface.
      this._enqueuePageLeg(() => new Promise((innerResolve) => {
        const passThrough = (result) => {
          resolve(result);
          innerResolve(result);
        };
        this._resolvePageLegTab().then((tab) => {
          if (this._batchCancelled) {
            console.log('[EmbedFrame] Batch stopped, skipping');
            return passThrough(null);
          }
          if (!tab) {
            console.log('[EmbedFrame] No YouTube tab found');
            return passThrough(null);
          }
          const timer = setTimeout(() => {
            console.log('[EmbedFrame] Timeout');
            passThrough(null);
          }, timeout);
          chrome.tabs.sendMessage(tab.id, {
            type: 'INJECT_EMBED_FRAME',
            videoId,
            lang: lang !== 'auto' ? lang : null,
            timeout: timeout - 2000
          }, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              console.warn('[EmbedFrame] Runtime error:', chrome.runtime.lastError.message);
              return passThrough(null);
            }
            if (!response?.success) {
              console.log('[EmbedFrame] Failed:', response?.error || 'Unknown error');
              if (response?.logs) response.logs.forEach(l => console.log('[Content]', l));
              return passThrough(null);
            }
            if (response?.result && response.result.length > 0) {
              console.log(`[EmbedFrame] Success: ${response.result.length} segments`);
              passThrough(response.result);
            } else {
              console.log('[EmbedFrame] Empty result');
              passThrough(null);
            }
          });
        });
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // PLAYER COERCION (Pathway 1): Use native YT player
  // Calls player.loadVideoById() + loadModule("captions") to force
  // the real YouTube player to solve BotGuard and request timedtext.
  // Requires an active YouTube tab with a initialized player.
  // ─────────────────────────────────────────────────────────────
  async _coercePlayerTranscript(videoId, options = {}) {
    const { lang = 'auto', timeout = 25000 } = options;
    // Serialize: every caller drives the same movie_player via loadVideoById.
    return new Promise((resolve) => {
      this._enqueuePageLeg(() => new Promise((innerResolve) => {
        const passThrough = (result) => {
          resolve(result);
          innerResolve(result);
        };
        if (this._batchCancelled) {
          console.log('[CoercePlayer] Batch stopped, skipping');
          return passThrough(null);
        }
        this._resolvePageLegTab().then((tab) => {
          if (!tab) {
            console.log('[CoercePlayer] No YouTube tab found');
            return passThrough(null);
          }
          const timer = setTimeout(() => {
            console.log('[CoercePlayer] Timeout');
            passThrough(null);
          }, timeout);
          chrome.tabs.sendMessage(tab.id, {
            type: 'COERCE_PLAYER_TRANSCRIPT',
            videoId,
            lang: lang !== 'auto' ? lang : null,
            desiredLang: lang !== 'auto' ? lang : null,
            timeout: timeout - 2000
          }, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              console.warn('[CoercePlayer] Runtime error:', chrome.runtime.lastError.message);
              return passThrough(null);
            }
            if (!response?.success) {
              console.log('[CoercePlayer] Failed:', response?.error || 'Unknown error');
              if (response?.logs) response.logs.forEach(l => console.log('[Content]', l));
              return passThrough(null);
            }
            if (response?.result && response.result.length > 0) {
              console.log(`[CoercePlayer] Success: ${response.result.length} segments`);
              passThrough(response.result);
            } else {
              console.log('[CoercePlayer] Empty result');
              passThrough(null);
            }
          });
        });
      }));
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
      this._enqueuePageLeg(() => new Promise((innerResolve) => {
        const passThrough = (result) => {
          resolve(result);
          innerResolve(result);
        };
        if (this._batchCancelled) {
          console.log('[TabNav] Batch stopped, skipping navigation');
          return passThrough(null);
        }
        this._resolvePageLegTab().then((tab) => {
        if (!tab) {
          console.log('[TabNav] No YouTube tab found');
          return passThrough(null);
        }

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
        let startTimer = null;

        const cleanup = () => {
          resolved = true;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
          if (startTimer) { clearTimeout(startTimer); startTimer = null; }
          chrome.tabs.onUpdated.removeListener(onUpdated);
        };

        timeoutTimer = setTimeout(() => {
          if (resolved) { cleanup(); return; }
          resolved = true;
          console.log('[TabNav] Timeout');
          cleanup();
          passThrough(null);
        }, timeout);

        // Fast-abort: after navigation, check the player tracklist once
        // settled. A confirmed-this-video response with 0 tracks means the
        // page has nothing to capture — abort in ~10s instead of the full
        // timeout. A videoId mismatch (mid-navigation response) is NOT
        // settled and keeps polling. 0.5 Auth still runs afterwards (0.7s,
        // independent path) so this aborts only the tab wait, not the video.
        let settledZeroStreak = 0;
        let probeInFlight = false;
        const startPolling = () => {
          // #7: a second `complete` (consent/redirect chains load the
          // document twice) used to schedule another startPolling, and a
          // second setInterval overwrote pollTimer — cleanup then cleared
          // only the latest and the first kept POLLING forever, resetting
          // the MV3 SW idle timer on every tick. Idempotent by construction:
          // resolved → the leg is done; pollTimer → already polling.
          if (resolved || pollTimer) return;
          pollTimer = setInterval(() => {
            if (this._batchCancelled && !resolved) {
              console.log('[TabNav] Batch stopped, aborting wait');
              resolved = true;
              cleanup();
              return passThrough(null);
            }
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
                return;
              }
              // Settled-with-0-tracks: the ISOLATED-side answer is always
              // false (dead read), so confirm via the MAIN-world probe.
              // Async — skip this tick if a probe is already in flight.
              if (probeInFlight) return;
              probeInFlight = true;
              const checkSettled = response?.settledNoTracks === true
                ? Promise.resolve(true)
                : this._probeSettledNoTracks(tab.id, videoId)
                    .then((r) => r.settled && r.trackCount === 0);
              checkSettled.then((settledZero) => {
                probeInFlight = false;
                if (resolved) return;
                if (settledZero) {
                  settledZeroStreak++;
                  if (settledZeroStreak >= 2) {
                    console.log('[TabNav] Settled with 0 tracks, aborting wait (~10s, Auth still runs)');
                    resolved = true;
                    cleanup();
                    passThrough(null);
                  }
                } else {
                  settledZeroStreak = 0;
                }
              });
            });
          }, 800);
        };

        const onUpdated = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            // Replace any pending settle timer so only the LATEST load's
            // 3s window survives; cleanup clears whatever is pending.
            if (startTimer) clearTimeout(startTimer);
            startTimer = setTimeout(() => {
              startPolling();
            }, 3000);
          }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.update(tab.id, { url: watchUrl });
      });   // chrome.tabs.query
    }));    // inner promise + _pageLegLock.then()
  });       // outer promise
}

  /**
   * MAIN-world probe: is the player settled on this video with 0 caption
   * tracks? The ISOLATED-world POLL_TRANSCRIPT answer for this is dead code
   * (content scripts cannot see page-JS expandos — proven 2026-09-20 and
   * documented in content.js), so 2C's fast-abort reads the player here via
   * chrome.scripting world:'MAIN' instead. Any failure = "not settled"
   * (keeps polling; never a false abort).
   */
  async _probeSettledNoTracks(tabId, videoId) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (vid) => {
          const p = document.getElementById('movie_player');
          const r = (p && typeof p.getPlayerResponse === 'function') ? p.getPlayerResponse() : null;
          if (!r || r.videoDetails?.videoId !== vid) return { settled: false };
          const tracks = r.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          return { settled: true, trackCount: tracks.length };
        },
        args: [videoId]
      });
      return res?.result || { settled: false };
    } catch (e) {
      return { settled: false };
    }
  }

  /**
   * Seed the active YouTube tab to a /watch page ONCE per batch so Tier 1.7
   * player coercion has a real movie_player to drive via loadVideoById.
   * No-op when the tab is already on /watch. Saves the pre-batch URL for
   * restoreOriginalTab. Resolves true when a usable player is present.
   */
  async seedWatchPage(videoId, playlistId = null, timeout = 45000) {
    const tab = await this._resolvePageLegTab();
    if (!tab) {
      console.log('[WatchSeed] No YouTube tab found');
      return false;
    }

    // Pin THIS tab for the whole batch — later 1.5/1.7/2C/restore calls must
    // keep driving it even if the user switches to another YouTube tab.
    this._batchTabId = tab.id;

    if (!this._originalTabUrl) this._originalTabUrl = tab.url;

    // Pin this batch's video in the URL (autoplay=0 keeps YT from wandering
    // to "up next" mid-batch — observed 2026-09-20: seed returned "ready"
    // for jGg_1h0qzaM while coercing u-CLv5-hbqk). Re-navigate when the tab
    // is not on our video, even if it is already a /watch page.
    const wantUrl = (vid) => {
      let url = `https://www.youtube.com/watch?v=${vid}&autoplay=0`;
      if (playlistId) url += `&list=${playlistId}`;
      return url;
    };
    const tabVid = (() => { try { return new URL(tab.url || '').searchParams.get('v'); } catch (e) { return null; } })();
    if (tabVid !== videoId) {
      const url = wantUrl(videoId);
      console.log(`[WatchSeed] Navigating tab ${tab.id} once to ${url}`);
      await chrome.tabs.update(tab.id, { url });
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }, 30000);
        const onUpdated = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
      });
      await new Promise((r) => setTimeout(r, 3000));
    }

    const probe = () => new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'CHECK_PLAYER_READY' }, (resp) => {
        if (chrome.runtime.lastError) {
          return resolve({ __err: chrome.runtime.lastError.message });
        }
        resolve(resp || null);
      });
    });
    const deadline = Date.now() + Math.max(timeout - 33000, 15000);
    let lastErr = null;
    while (Date.now() < deadline) {
      const state = await probe();
      if (state?.__err) {
        // No listener on this tab (navigating / wrong target) — log verbatim
        // so "messaging the wrong tab" is distinguishable from withheld tracks.
        if (state.__err !== lastErr) {
          console.log(`[WatchSeed] tab ${tab.id} probe error: ${state.__err}`);
          lastErr = state.__err;
        }
      } else if (state?.ready === true && state?.hasCaptions === true) {
        console.log(`[WatchSeed] Player ready with attested tracklist (${state.trackCount}: ${state.tracks.join(', ')})`);
        return true;
      } else if (state?.ready === true) {
        console.log(`[WatchSeed] tab ${tab.id} API ready, no tracklist yet (state=${state.playerState}, page=${state.url})`);
      } else if (state) {
        console.log(`[WatchSeed] tab ${tab.id} hasPlayer=${state.hasPlayer} (page=${state.url})`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Best effort: the API may still serve even if the tracklist probe missed.
    const last = await probe();
    if (last?.__err) {
      console.log(`[WatchSeed] Player never became ready (tab ${tab.id} probe error: ${last.__err})`);
      return false;
    }
    console.log(last?.ready === true
      ? `[WatchSeed] Player API ready, tracklist unconfirmed (state=${last.playerState}, tracks=${last.trackCount}, page=${last.url})`
      : `[WatchSeed] Player never became ready (tab ${tab.id}, hasPlayer=${last?.hasPlayer}, page=${last?.url})`);
    return last?.ready === true;
  }

  // ─────────────────────────────────────────────────────────────
  // RESTORE ORIGINAL TAB (after batch navigation is done)
  // ─────────────────────────────────────────────────────────────
  async restoreOriginalTab() {
    const originalUrl = this._originalTabUrl;
    this._originalTabUrl = null;
    const pinnedId = this._batchTabId;
    this._batchTabId = null;
    this._batchCancelled = false;
    if (!originalUrl) return;

    try {
      // Restore the tab the batch actually drove (the pin), not whichever
      // YouTube tab happens to be active now.
      const tab = (pinnedId != null)
        ? await chrome.tabs.get(pinnedId).catch(() => null)
        : await this._resolvePageLegTab();
      if (!tab) return;
      if (tab.url && tab.url.includes('/watch')) {
        console.log(`[TabNav] Restoring tab ${tab.id} to original URL: ${originalUrl}`);
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
          // Pass 'auto' through: getSubtitles already resolves it to the first
          // available track. Substituting 'en' here made videos whose only
          // captions are in another language fail with "Language en not found".
          lang: sourceLang,
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

      // #5: never cache or return an empty transcript as success — every other
      // tier length-checks before caching. JSON3 can parse with `events`
      // present but no usable segs (brand-new video, cue-less ASR); returning
      // [] here returned "Done!" + an empty .srt and poisoned the cache until
      // Reset. Throwing lands in the catch below → next tier, nothing cached.
      if (!result || result.length === 0) {
        throw new Error('No usable segments in caption response');
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

    // Stop checkpoints: the Stop button sets _batchCancelled; every tier
    // boundary below throws a `stopped` error (BatchProcessor does not count
    // these as failures) instead of spending seconds on more tiers. The cache
    // check above intentionally returns before the first checkpoint (#15): a
    // cached lookup completes instantly, so there are no boundaries to guard.
    const throwIfStopped = () => {
      if (!this._batchCancelled) return;
      log('[Batch] Stopped — aborting remaining tiers for this video');
      const stopped = new Error(`Batch stopped for ${videoId}`);
      stopped.logs = logs;
      stopped.stopped = true;
      throw stopped;
    };
    throwIfStopped();

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

    throwIfStopped();
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

    throwIfStopped();
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

    throwIfStopped();
    // === FALLBACK: Try Tier 1 (updated client chain: IOS -> MWEB -> WEB_EMBEDDED) ===
    // Only used if Tier 3 fails, for edge cases
    try {
      log('[Tier 1 Fallback] Attempting updated client chain...');
      
      const result = await getSubtitles({
        videoID: videoId,
        // Pass 'auto' through: getSubtitles resolves it to the first available
        // track. Substituting 'en' broke videos whose captions are not English.
        lang: sourceLang,
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
    throwIfStopped();
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

    // === TIER 1.6 (Embed Frame): DISABLED in batch ===
    // Probes showed the nocookie iframe never fires a caption request for
    // ASR-gated videos — it burned 10-25s per video for zero captures and
    // shared the coercion lock (serialized dead wait). _fetchTranscriptViaEmbedFrame
    // and the INJECT_EMBED_FRAME content handler remain but currently have
    // NO callers anywhere (verified 2026-09-25 — not even single-video);
    // batch
    // goes straight from cold tiers to 1.7 player coercion. (2026-09-20)

    // === TIER 1.7 (Player Coercion): loadVideoById on the shared player ===
    // Switches videos in-page via player.loadVideoById() — no navigation, no
    // page load — so the REAL player solves BotGuard and makes
    // PoToken-authenticated timedtext requests, captured by the MAIN-world
    // sniffer. Requires the tab to already be on a /watch page (batch seeds
    // it once via seedWatchPage in main.mjs); otherwise the content script
    // fails fast. Serialized on _pageLegLock — the ONE lock shared with 2C,
    // because both drive the same pinned tab; API tiers above stay parallel.
    throwIfStopped();
    try {
      log('[Tier 1.7 Player Coercion] Coercing shared player...');
      const coerced = await this._coercePlayerTranscript(videoId, {
        lang: sourceLang,
        timeout: 25000
      });

      if (coerced && coerced.length > 0) {
        log(`[Tier 1.7 Player Coercion] Success! ${coerced.length} segments`);
        const response = {
          source: 'tier1.7-player-coercion',
          result: coerced,
          translated: translate,
          sourceLang,
          targetLang,
          logs
        };
        this._setCache(cacheKey, response);
        return response;
      }
      log('[Tier 1.7 Player Coercion] No transcript captured, falling through...');
    } catch (err) {
      errors.push({ tier: '1.7-player-coercion', error: err.message });
      log(`[Tier 1.7 Player Coercion] Failed: ${err.message}`);
    }

    // === TIER 2C (Tab Navigation): Navigate to watch page ===
    // Navigates the active YouTube tab to the video's watch page.
    // The REAL player solves BotGuard and makes PoToken-authenticated
    // timedtext request. The sniffer captures the response body.
    // This is the only tier that reliably works for heavily restricted
    // videos. The tab briefly visits each video.
    throwIfStopped();
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
    throwIfStopped();
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
  // NOTE: only ONE clearCache may exist on the class. A no-arg duplicate here
  // (removed 2026-09-25) shadowed the per-video definition above, so
  // main.mjs:253's videoId argument was ignored and Reset wiped everything
  // including playlist:* entries (#10). The definition at the top handles
  // both shapes: videoId → scoped clear, no arg → clear all.
}

// Singleton
export const translationManager = new TranslationManager();
