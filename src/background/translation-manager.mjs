
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
  // Get Video Metadata (Languages + Title)
  // ─────────────────────────────────────────────────────────────
  async getMetadata(videoId) {
    const cacheKey = `metadata:${videoId}`;
    if (this.cache.has(cacheKey)) {
      console.log(`[TranslationManager] Metadata cache hit for ${videoId}`);
      return this.cache.get(cacheKey);
    }

    console.log(`[TranslationManager] Metadata cache miss for ${videoId}, fetching...`);

    // Tier 1
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
    try {
        const tier2Langs = await this._getLanguagesTier2(videoId);
        if (tier2Langs && tier2Langs.length > 0) {
            const result = {
                title: 'YouTube Video',
                languages: tier2Langs
            };
            this.cache.set(cacheKey, result);
            return result;
        }
    } catch (e2) {
        console.warn('Tier 2 Metadata failed:', e2);
    }

    // Tier 3
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

  async _getLanguagesTier2(videoId) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) return resolve([]);
        
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_TIER2_LANGUAGES', videoId }, (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            return resolve([]);
          }
          resolve(response.languages || []);
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
                             const bgRes = await fetch(response.url, { credentials: 'include' });
                             const text = await bgRes.text();
                             
                             log(`[Tier 4] Background Fetch Status: ${bgRes.status} ${bgRes.statusText}`);
                             log(`[Tier 4] Background Body Length: ${text.length}`);
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
