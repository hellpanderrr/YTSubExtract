
// === UNIVERSAL TRANSLATION MANAGER ===
// Handles all 3 libraries + YouTube Native API

import { getSubtitles, getLanguages } from '../utils/youtube-caption-extractor.js';
import { fetchTier3Transcript, getVideoMetadata as getVideoMetadataTier3 } from './tier3-worker.mjs';
import { SUPPORTED_LANGUAGES } from '../utils/languages.js';
import he from 'he';

export class TranslationManager {
  constructor() {
    this.availableLanguages = null;
    this.cache = new Map();
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
  // TIER 0: Network Sniffer (captured URLs)
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

    console.log(`[TranslationManager] Metadata cache miss for ${videoId}, fetching...`);

    // Tier 0.5: Player API (first priority)
    try {
        const tier05Result = await this._getLanguagesTier0_5(videoId);
        if (tier05Result.languages && tier05Result.languages.length > 0) {
            console.log(`[TranslationManager] Tier 0.5 success: ${tier05Result.languages.length} languages`);
            const result = {
                title: tier05Result.title || 'YouTube Video',
                languages: tier05Result.languages
            };
            this.cache.set(cacheKey, result);
            return result;
        }
    } catch (e05) {
        console.warn('Tier 0.5 Metadata failed:', e05);
    }

    // Tier 1.5: Embed Page (Guest Mode / Age-Restricted Bypass)
    // MOVED BEFORE Tier 1 - Embed works for guests!
    try {
        const tier15Result = await this._getLanguagesTier1_5(videoId);
        if (tier15Result.languages && tier15Result.languages.length > 0) {
            console.log(`[TranslationManager] Tier 1.5 success: ${tier15Result.languages.length} languages`);
            const result = {
                title: tier15Result.title || 'YouTube Video',
                languages: tier15Result.languages
            };
            this.cache.set(cacheKey, result);
            return result;
        }
    } catch (e15) {
        console.warn('Tier 1.5 Metadata failed:', e15);
    }

    // Tier 1: Android/iOS/TVHTML5 API (requires auth for some videos)
    try {
        const { languages, title } = await getLanguages(videoId);
        if (languages && languages.length > 0) {
            const result = {
                title: title || 'YouTube Video',
                languages: languages.map(l => ({
                    code: l.languageCode,
                    name: l.languageName,
                    isAuto: l.kind === 'asr'
                }))
            };
            this.cache.set(cacheKey, result);
            return result;
        }
        // If Tier 1 returned no languages, log it
        console.warn('Tier 1 Metadata returned no languages');
    } catch (e1) {
        // If Tier 1 failed (e.g. Sign in required), log it
        console.warn('Tier 1 Metadata failed:', e1.message || e1);
    }

    // Tier 2
    console.log('[TranslationManager] Trying Tier 2...');
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
            this.cache.set(cacheKey, result);
            return result;
        }
    } catch (e2) {
        console.warn('Tier 2 Metadata failed:', e2);
    }

    // Tier 3
    console.log('[TranslationManager] Trying Tier 3...');
    try {
        const result = await getVideoMetadataTier3(videoId);
        if (result && result.languages && result.languages.length > 0) {
            this.cache.set(cacheKey, result);
            return result;
        }
        console.warn('Tier 3 returned no languages, falling back to Tier 4...');
    } catch (e3) {
        console.error('Tier 3 Metadata failed:', e3);
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
             this.cache.set(cacheKey, meta);
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
      
      const response = await fetch(`https://www.youtube.com/embed/${videoId}`);
      console.log(`[Tier 1.5] Fetch status: ${response.status}`);
      
      if (!response.ok) {
        throw new Error(`Embed page fetch failed: ${response.status}`);
      }
      
      const html = await response.text();
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
      
      const response = await fetch(`https://www.youtube.com/embed/${videoId}`);
      const html = await response.text();
      
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
      if (translate && targetLang) {
        fetchUrl += `&tlang=${targetLang}`;
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
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve([]);
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_TIER2_LANGUAGES', videoId }, (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            return resolve([]);
          }
          // Also capture title if returned
          if (response.title) {
            this._cachedTitle = response.title;
          }
          resolve(response.languages || []);
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
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve({ languages: [] });
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_CONTEXT_LANGUAGES', videoId }, (response) => {
          if (chrome.runtime.lastError) {
              console.error('[Tier 4] Runtime error:', chrome.runtime.lastError.message);
              return resolve({ languages: [] });
          }

          if (response?.logs) {
              console.groupCollapsed('[Tier 4] Page Context Logs');
              response.logs.forEach(l => console.log(l));
              console.groupEnd();
          }

          if (!response?.success) {
            console.error('[Tier 4] Failed:', response?.error || 'Unknown error');
            return resolve({ languages: [] });
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
                fetchUrl = fetchUrl.replace(/tlang=[^&]+&?/, '');
                // Clean up trailing &
                fetchUrl = fetchUrl.replace(/&$/, '');
            }
            
            if (translate && targetLang && !fetchUrl.includes('tlang=')) {
                fetchUrl += `&tlang=${targetLang}`;
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
                                this.cache.set(cacheKey, resp);
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
                fetchUrl += `&tlang=${targetLang}`;
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
                                this.cache.set(cacheKey, resp);
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
          this.cache.set(cacheKey, response);
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
        this.cache.set(cacheKey, response);
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
             this.cache.set(cacheKey, response);
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
      this.cache.set(cacheKey, response);
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
             this.cache.set(cacheKey, response);
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
             this.cache.set(cacheKey, response);
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
  // Cache Clear
  // ─────────────────────────────────────────────────────────────
  clearCache() {
    this.cache.clear();
  }
}

// Singleton
export const translationManager = new TranslationManager();
