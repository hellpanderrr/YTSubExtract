import { YouTubeTranscriptApi } from '@playzone/youtube-transcript/dist/api/index.js';

// Content Script works in the context of youtube.com
// Has access to cookies and correct headers

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_CAPTION_TRACKS') {
    getCaptionTracks(msg.videoId)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (msg.type === 'FETCH_TIER2_TRANSCRIPT') {
    (async () => {
      try {
        const api = new YouTubeTranscriptApi();
        const list = await api.list(msg.videoId);
        
        let transcript;
        if (msg.lang && msg.lang !== 'auto') {
            transcript = list.findTranscript([msg.lang]);
        } else {
            // If auto, prefer manually created, then generated.
            // Try English or the first available.
            transcript = list.findTranscript(['en']); 
            if (!transcript) {
                const all = [...list.manuallyCreatedTranscripts.values(), ...list.generatedTranscripts.values()];
                if (all.length > 0) transcript = all[0];
            }
        }

        if (!transcript) {
            throw new Error(`No transcript found for language: ${msg.lang || 'auto'}`);
        }

        // Handle translation
        if (msg.translate && msg.translateLang) {
            transcript = transcript.translate(msg.translateLang);
        }

        const result = await transcript.fetch();
        
        // Convert to standard format
        const segments = result.snippets.map(s => ({
            start: s.start,
            duration: s.duration,
            text: s.text
        }));

        sendResponse({ success: true, result: segments });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorStack = err instanceof Error ? err.stack : '';
        sendResponse({ success: false, error: errorMessage, stack: errorStack });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_TIER2_LANGUAGES') {
    (async () => {
        try {
            const api = new YouTubeTranscriptApi();
            const list = await api.list(msg.videoId);
            const all = [...list.manuallyCreatedTranscripts.values(), ...list.generatedTranscripts.values()];
            const languages = all.map(t => ({
                code: t.languageCode,
                name: t.language,
                isTranslatable: t.isTranslatable
            }));
            sendResponse({ success: true, languages });
        } catch (err) {
            sendResponse({ success: false, error: err.message });
        }
    })();
    return true;
  }

  if (msg.type === 'FETCH_TRANSLATED') {
    fetchTranslatedSubtitles(msg.videoId, msg.sourceLang, msg.targetLang, msg.translate)
      .then(result => sendResponse({ success: true, result: result.data, logs: result.logs }))
      .catch(err => sendResponse({ success: false, error: err.message, logs: err.logs || [] }));
    return true; // Keep channel open for async response
  }

  if (msg.type === 'GET_BEST_CAPTION_URL') {
    getBestCaptionUrl(msg.videoId, msg.sourceLang, msg.targetLang, msg.translate, msg.forceRefresh)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message, logs: err.logs || [] }));
    return true;
  }

  if (msg.type === 'GET_PAGE_CONTEXT_LANGUAGES') {
    (async () => {
        const logs = [];
        const log = (m) => logs.push(`[Content] ${m}`);
        try {
            const playerResponse = await getRobustPlayerResponse(log);

            if (!playerResponse || !playerResponse.captions) {
                 if (playerResponse) {
                     log(`Found playerResponse but NO CAPTIONS. VideoId: ${playerResponse.videoDetails?.videoId}, Title: ${playerResponse.videoDetails?.title}`);
                     // Check if playabilityStatus says anything
                     if (playerResponse.playabilityStatus) {
                         log(`Playability: ${playerResponse.playabilityStatus.status}`);
                     }
                 } else {
                     log('No playerResponse found after all attempts.');
                 }
                 throw new Error('No captions found in page context.');
            }
            
            const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            log(`Found ${captionTracks.length} caption tracks.`);
            
            const languages = captionTracks.map(t => ({
                code: t.languageCode,
                name: t.name.simpleText,
                isAuto: t.kind === 'asr'
            }));
            
            sendResponse({ success: true, languages, title: playerResponse.videoDetails?.title, logs });
        } catch (err) {
            sendResponse({ success: false, error: err.message, logs });
        }
    })();
    return true;
  }

  if (msg.type === 'FETCH_PAGE_CONTEXT_TRANSCRIPT') {
    (async () => {
        const logs = [];
        const log = (m) => logs.push(`[Content] ${m}`);
        
        const tryFetchTranscript = async (url) => {
             try {
                 log(`Fetching transcript from: ${url}`);
                 
                 // Try fetch directly
                 const response = await fetch(url);
                 const text = await response.text();
                 
                 log(`Fetch Response Status: ${response.status} ${response.statusText}`);
                 log(`Fetch Response Body Length: ${text.length}`);
                 
                 // Log headers to debug empty body
                 const headers = {};
                 response.headers.forEach((val, key) => { headers[key] = val; });
                 log(`Response Headers: ${JSON.stringify(headers)}`);

                 // Check for 204 No Content explicitly
                 if (response.status === 204) {
                     log('Status 204 No Content received.');
                     return { ok: false, status: 204, text: '', url };
                 }

                 if (response.ok && text.length > 0) {
                     return { ok: true, status: response.status, text, url };
                 } else {
                     log(`Fetch failed or empty. Status: ${response.status}. Body Len: ${text.length}`);
                     
                     // If we got a 200 OK but empty body, check if we can retry with no-cache
                     if (response.status === 200 && text.length === 0) {
                         log('Trying one more time with cache-control: no-cache...');
                         try {
                             const retry = await fetch(url, { cache: 'no-store' });
                             const retryText = await retry.text();
                             log(`Retry Status: ${retry.status}, Len: ${retryText.length}`);
                             if (retryText.length > 0) {
                                 return { ok: true, status: retry.status, text: retryText, url };
                             }
                         } catch (e) {
                             log(`Retry failed: ${e.message}`);
                         }
                     }
                     
                     return { ok: false, status: response.status, text, url };
                 }
             } catch (e) {
                 log(`Fetch error: ${e.message}`);
                 return { ok: false, status: 0, text: '', url };
             }
        };

        try {
            let playerResponse = await getRobustPlayerResponse(log);
            
            if (!playerResponse || !playerResponse.captions) {
                 throw new Error('No player response found in page context');
            }
            
            // Helper to extract track URL from response
            const getTrackUrl = (pr, lang, translate, translateLang) => {
                const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                
                // Log all available tracks for debugging
                log(`Available tracks in playerResponse: ${tracks.length}`);
                tracks.forEach((t, i) => {
                    log(`Track #${i}: lang=${t.languageCode}, name=${t.name?.simpleText}, kind=${t.kind}, vssId=${t.vssId}`);
                });

                let t;
                if (lang === 'auto') {
                    t = tracks.find(x => x.languageCode === 'en') || tracks[0];
                } else {
                    t = tracks.find(x => x.languageCode === lang);
                }
                if (!t) {
                    log(`No track found for lang=${lang}. Picking first available.`);
                    t = tracks[0];
                }
                if (!t) return null;
                
                log(`Selected track: lang=${t.languageCode}, kind=${t.kind}, baseUrl=${t.baseUrl.substring(0, 50)}...`);

                let u = t.baseUrl;
                if (translate && translateLang) {
                    u += `&tlang=${translateLang}`;
                }
                
                // Check expiration
                const expireMatch = u.match(/expire=(\d+)/);
                if (expireMatch) {
                    const expireTime = parseInt(expireMatch[1], 10);
                    const now = Math.floor(Date.now() / 1000);
                    const diff = expireTime - now;
                    log(`URL Expire: ${expireTime} (Now: ${now}, Diff: ${diff}s)`);
                }
                
                return u;
            };

            let url = getTrackUrl(playerResponse, msg.lang, msg.translate, msg.translateLang);
            if (!url) throw new Error('Track not found');
            
            let fetchResult = await tryFetchTranscript(url);
            
            // If empty, try to refresh playerResponse
            if (!fetchResult.text || fetchResult.text.trim().length === 0) {
                log('Empty response. forcing refresh of playerResponse via page fetch...');
                playerResponse = await getRobustPlayerResponse(log, true); // Force refresh
                
                if (playerResponse && playerResponse.captions) {
                    const newUrl = getTrackUrl(playerResponse, msg.lang, msg.translate, msg.translateLang);
                    if (newUrl && newUrl !== url) {
                        log('Got new URL from fresh page data. Retrying fetch...');
                        fetchResult = await tryFetchTranscript(newUrl);
                        fetchResult.url = newUrl;
                    } else {
                         log('Fresh page data yielded same URL or no URL. Retrying original URL with json3...');
                    }
                }
            }

            let xmlText = fetchResult.text;
            
            // Retry with json3 if XML failed/empty
            if (!xmlText || xmlText.trim().length === 0) {
                 log(`XML body empty. Retrying with fmt=json3...`);
                 
                 // If we have a fresh URL from refresh, use it. Otherwise use original.
                 // Note: tryFetchTranscript updates 'fetchResult' but not 'url' variable.
                 // We should check if fetchResult has a new URL.
                 let urlToUse = fetchResult.url || url;
                 
                 let jsonUrl = urlToUse;
                 if (jsonUrl.includes('fmt=')) {
                    jsonUrl = jsonUrl.replace(/fmt=[^&]+/, 'fmt=json3');
                 } else {
                    jsonUrl += '&fmt=json3';
                 }
                 
                 log(`Fetching JSON3 from: ${jsonUrl}`);
                 try {
                     const jsonResp = await fetch(jsonUrl, { credentials: 'include' });
                     const jsonText = await jsonResp.text();
                     log(`JSON3 Response Status: ${jsonResp.status} ${jsonResp.statusText}`);
                     
                     if (jsonText && jsonText.trim().length > 0) {
                         // Log preview of JSON3 response for debugging
                         log(`JSON3 Body Preview (first 500 chars): ${jsonText.substring(0, 500)}`);
                         
                         try {
                             const json = JSON.parse(jsonText);
                             const events = json.events;
                             if (events) {
                                 const segments = events
                                    .filter(e => e.segs)
                                    .map(e => ({
                                        start: (e.tStartMs || 0) / 1000,
                                        duration: (e.dDurationMs || 0) / 1000,
                                        text: e.segs.map(s => s.utf8 || '').join('')
                                    }))
                                    .filter(e => e.text.trim().length > 0);

                                 log(`Parsed ${segments.length} segments from JSON3.`);
                                 sendResponse({ success: true, result: segments, logs });
                                 return;
                             } else {
                                 log('JSON3 parsed but no events found.');
                             }
                         } catch (e) {
                             log(`JSON3 parse failed: ${e.message}`);
                         }
                     } else {
                         log('JSON3 response body is empty.');
                     }
                 } catch (e) {
                     log(`JSON3 fetch failed: ${e.message}`);
                 }

                 // Try VTT if JSON3 failed
                 let vttUrl = urlToUse;
                 if (vttUrl.includes('fmt=')) {
                    vttUrl = vttUrl.replace(/fmt=[^&]+/, 'fmt=vtt');
                 } else {
                    vttUrl += '&fmt=vtt';
                 }
                 
                 log(`Fetching VTT from: ${vttUrl}`);
                 try {
                     const vttResp = await fetch(vttUrl);
                     const vttText = await vttResp.text();
                     log(`VTT Response Status: ${vttResp.status}`);
                     
                     if (vttText && vttText.trim().length > 0 && vttText.includes('WEBVTT')) {
                         log(`VTT Body Preview: ${vttText.substring(0, 200)}`);
                         // Simple VTT parser
                         const lines = vttText.split('\n');
                         const segments = [];
                         let currentStart = 0;
                         let currentDur = 0;
                         let currentText = [];
                         
                         for (let line of lines) {
                             line = line.trim();
                             if (!line) continue;
                             if (line === 'WEBVTT') continue;
                             
                             // Timestamp line: 00:00:00.000 --> 00:00:05.000
                             const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s-->\s(\d{2}:\d{2}:\d{2}\.\d{3})/);
                             if (timeMatch) {
                                 if (currentText.length > 0) {
                                     segments.push({
                                         start: currentStart,
                                         duration: currentDur,
                                         text: currentText.join(' ')
                                     });
                                     currentText = [];
                                 }
                                 
                                 const parseTime = (t) => {
                                     const parts = t.split(':');
                                     return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                                 };
                                 
                                 currentStart = parseTime(timeMatch[1]);
                                 const end = parseTime(timeMatch[2]);
                                 currentDur = end - currentStart;
                             } else if (!line.match(/^\d+$/)) {
                                 // Text line (skip cue numbers)
                                 currentText.push(line);
                             }
                         }
                         
                         if (currentText.length > 0) {
                              segments.push({
                                  start: currentStart,
                                  duration: currentDur,
                                  text: currentText.join(' ')
                              });
                         }
                         
                         if (segments.length > 0) {
                    log(`Parsed ${segments.length} segments from VTT.`);
                    sendResponse({ success: true, result: segments, logs });
                    return;
                }
            }
        } catch (e) {
            log(`VTT fetch failed: ${e.message}`);
        }
        
        // Try SRV3 (XML-based but different)
        let srv3Url = urlToUse.replace(/fmt=[^&]+/, '') + '&fmt=srv3';
        log(`Fetching SRV3 from: ${srv3Url}`);
        try {
            const srv3Resp = await fetch(srv3Url);
            const srv3Text = await srv3Resp.text();
            log(`SRV3 Response Status: ${srv3Resp.status}, Len: ${srv3Text.length}`);
            if (srv3Text.length > 0 && srv3Text.includes('<text')) {
                // Parse SRV3 (similar to XML)
                 const parser = new DOMParser();
                 const xmlDoc = parser.parseFromString(srv3Text, "text/xml");
                 const texts = xmlDoc.getElementsByTagName('text');
                 const segs = [];
                 for (let i = 0; i < texts.length; i++) {
                     const node = texts[i];
                     const start = parseFloat(node.getAttribute('start') || node.getAttribute('t') / 1000);
                     const dur = parseFloat(node.getAttribute('dur') || node.getAttribute('d') / 1000);
                     let text = node.textContent;
                     if (text) segs.push({ start, duration: dur, text });
                 }
                 if (segs.length > 0) {
                     log(`Parsed ${segs.length} segments from SRV3.`);
                     sendResponse({ success: true, result: segs, logs });
                     return;
                 }
            }
        } catch(e) { log(`SRV3 fetch failed: ${e.message}`); }

        // Last resort: Clean URL (no signature) with credentials
        // This fixes cases where the signed URL from playerResponse is broken/IP-bound
        log(`[Tier 4] SRV3 empty. Trying Clean URL fallback...`);
        try {
            const vMatch = urlToUse.match(/[?&]v=([^&]+)/);
            const langMatch = urlToUse.match(/[?&]lang=([^&]+)/);
            
            if (vMatch && langMatch) {
                let cleanUrl = `https://www.youtube.com/api/timedtext?v=${vMatch[1]}&lang=${langMatch[1]}&fmt=json3`;
                const tlangMatch = urlToUse.match(/[?&]tlang=([^&]+)/);
                if (tlangMatch) cleanUrl += `&tlang=${tlangMatch[1]}`;
                const kindMatch = urlToUse.match(/[?&]kind=([^&]+)/);
                if (kindMatch) cleanUrl += `&kind=${kindMatch[1]}`;

                log(`[Tier 4] Fetching Clean URL (JSON3): ${cleanUrl}`);
                let cleanResp = await fetch(cleanUrl, { credentials: 'include' });
                let cleanText = await cleanResp.text();
                
                // If JSON3 fails, try VTT
                if (!cleanText || cleanText.trim().length === 0) {
                     log(`[Tier 4] JSON3 clean fetch empty. Trying VTT...`);
                     let vttUrl = cleanUrl.replace('fmt=json3', 'fmt=vtt');
                     cleanResp = await fetch(vttUrl, { credentials: 'include' });
                     cleanText = await cleanResp.text();
                     if (cleanText && cleanText.includes('WEBVTT')) {
                         log(`[Tier 4] VTT Clean fetch successful.`);
                         // Parse VTT simply
                         const lines = cleanText.split('\n');
                         const segs = [];
                         let currentStart = 0;
                         let currentText = '';
                         
                         for (let i = 0; i < lines.length; i++) {
                             const line = lines[i].trim();
                             if (line.includes('-->')) {
                                 const parts = line.split('-->');
                                 const startParts = parts[0].trim().split(':');
                                 const endParts = parts[1].trim().split(':');
                                 
                                 const parseTime = (t) => {
                                     const p = t.split('.');
                                     const sms = parseFloat('0.' + (p[1] || '0'));
                                     const hms = p[0].split(':').map(Number);
                                     let seconds = 0;
                                     if (hms.length === 3) seconds = hms[0]*3600 + hms[1]*60 + hms[2];
                                     else if (hms.length === 2) seconds = hms[0]*60 + hms[1];
                                     return seconds + sms;
                                 };
                                 
                                 if (currentText) {
                                     segs.push({ start: currentStart, duration: 0, text: currentText.trim() }); // Duration approx
                                     currentText = '';
                                 }
                                 currentStart = parseTime(parts[0].trim());
                             } else if (line && !line.includes('WEBVTT') && isNaN(line)) {
                                 currentText += line + ' ';
                             }
                         }
                         if (currentText) segs.push({ start: currentStart, duration: 0, text: currentText.trim() });
                         
                         if (segs.length > 0) {
                             sendResponse({ success: true, result: segs, logs });
                             return;
                         }
                     }
                }

                if (cleanText && cleanText.trim().length > 0) {
                    try {
                        const json = JSON.parse(cleanText);
                        if (json.events) {
                            const segments = json.events
                               .filter(e => e.segs)
                               .map(e => ({
                                   start: (e.tStartMs || 0) / 1000,
                                   duration: (e.dDurationMs || 0) / 1000,
                                   text: e.segs.map(s => s.utf8 || '').join('')
                               }))
                               .filter(e => e.text.trim().length > 0);
                            
                            if (segments.length > 0) {
                                log(`Parsed ${segments.length} segments from Clean URL.`);
                                sendResponse({ success: true, result: segments, logs });
                                return;
                            }
                        }
                    } catch (e) {
                        log(`Clean URL JSON3 parse failed: ${e.message}`);
                    }
                } else {
                    log(`Clean URL returned empty body.`);
                }
            }
        } catch (e) {
            log(`Clean URL fetch failed: ${e.message}`);
        }

        // If all local attempts failed, return URL to background can try
        if (urlToUse) {
            log(`Returning URL to background for fallback fetch. URL: ${urlToUse}`);
            log(`DEBUG: Try opening this URL in a new tab to see if it works: ${urlToUse}`);
            sendResponse({ success: false, error: 'Empty response from YouTube (XML, JSON3, VTT, SRV3)', url: urlToUse, logs });
            return;
        } else {
                     log('No URL available for fallback.');
                 }

                 throw new Error('Empty response from YouTube (XML and JSON3)');
            }
            
            // Parse XML
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "text/xml");
            const texts = xmlDoc.getElementsByTagName('text');
            
            const segments = [];
            for (let i = 0; i < texts.length; i++) {
                const node = texts[i];
                const start = parseFloat(node.getAttribute('start'));
                const dur = parseFloat(node.getAttribute('dur'));
                let text = node.textContent;
                
                if (text) {
                    segments.push({
                        start,
                        duration: dur,
                        text: text
                    });
                }
            }
            
            if (segments.length === 0) {
                 log('XML parsed 0 segments. XML Content snippet: ' + xmlText.substring(0, 200));
            }

            log(`Parsed ${segments.length} segments.`);
            sendResponse({ success: true, result: segments, logs });
            
        } catch (err) {
            sendResponse({ success: false, error: err.message, logs });
        }
    })();
    return true;
  }
});

// Helper to inject script and get variable from page context
function getPageVariable(variableName) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    const requestId = Math.random().toString(36).substring(7);
    
    const listener = (event) => {
      if (event.source === window && 
          event.data.type === 'PAGE_VARIABLE_RESULT' && 
          event.data.requestId === requestId) {
        window.removeEventListener('message', listener);
        resolve(event.data.value);
      }
    };
    window.addEventListener('message', listener);

    script.textContent = `
      (function() {
        try {
          const value = window['${variableName}'];
          window.postMessage({
            type: 'PAGE_VARIABLE_RESULT',
            requestId: '${requestId}',
            value: value
          }, '*');
        } catch (e) {
          window.postMessage({
            type: 'PAGE_VARIABLE_RESULT',
            requestId: '${requestId}',
            value: null,
            error: e.message
          }, '*');
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    
    setTimeout(() => {
        window.removeEventListener('message', listener);
        resolve(null);
    }, 1000);
  });
}

// Helper to get player response from page context
async function getRobustPlayerResponse(log, forceRefresh = false) {
    let playerResponse = null;

    if (!forceRefresh) {
        log('Attempting to get ytInitialPlayerResponse from window...');
        playerResponse = await getPageVariable('ytInitialPlayerResponse');

        if (playerResponse) {
            try {
                // Check if playerResponse is valid
                if (!playerResponse.captions) {
                     log('ytInitialPlayerResponse found but no captions object. Force refresh?');
                     // If it's empty, maybe we need to fetch the page again
                     playerResponse = null;
                }
            } catch (e) { log('Error checking ytInitialPlayerResponse:', e); }
        }
        
        if (!playerResponse) {
             log('Window variable missing. Scanning DOM scripts...');
             playerResponse = await getPlayerResponse();
        }
    } else {
        log('Skipping window/DOM scan due to forceRefresh.');
    }
    
    // If still missing or forced refresh, try to fetch the page using current session (Tier 2 style but manually)
    // This is useful if the variable was cleared but we can re-fetch the page with cookies.
    if (!playerResponse || forceRefresh) {
         log('Fetching page via content script (with cookies)...');
         try {
             const resp = await fetch(window.location.href);
             const text = await resp.text();
             const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
             if (match) {
                 playerResponse = JSON.parse(match[1]);
                 log('Successfully extracted from fetched page.');
             } else {
                 log('Fetched page but could not find ytInitialPlayerResponse.');
             }
         } catch (fetchErr) {
             log(`Fetch failed: ${fetchErr.message}`);
         }
    }
    return playerResponse;
}

function getPlayerResponse() {
    try {
        // Try to find the script tag containing ytInitialPlayerResponse
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';
            if (content.includes('ytInitialPlayerResponse')) {
                const match = content.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
                if (match) {
                    try {
                        return JSON.parse(match[1]);
                    } catch (e) {
                        // Continue searching
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Content] Failed to scan DOM for player response:', e);
    }
    return Promise.resolve(null);
}

async function getCaptionTracks(videoId, log = console.log, forceRefresh = false) {
  let playerResponse = await getPlayerResponse();

  // Helper to check expiration
  const checkExpiration = (response, source) => {
      if (!response || !response.captions) return false;
      const tracks = response.captions.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
          const firstTrack = tracks[0];
          if (firstTrack.baseUrl) {
              const expireMatch = firstTrack.baseUrl.match(/expire=(\d+)/);
              if (expireMatch) {
                  const expireTime = parseInt(expireMatch[1], 10);
                  const now = Math.floor(Date.now() / 1000);
                  log(`[Content] Checking expiration for ${source}: expire=${expireTime}, now=${now}, diff=${expireTime - now}`);
                  // If expired or expiring within 30 minutes (1800s) to be safe
                  if (expireTime < now + 1800) {
                      log(`[Content] ${source} expired or close to expiring. Fetching fresh...`);
                      return true;
                  }
              } else {
                  log(`[Content] No expire param in baseUrl for ${source}`);
              }
          }
      }
      return false;
  };

  let isExpired = checkExpiration(playerResponse, 'DOM Response');

  // Fallback: If page context didn't have it (rare), or if we want to be sure for the specific videoId
  // The injected script returns the CURRENT page's player response.
  // If the user navigated, it should be correct.
  // But let's verify videoId if possible? 
  // playerResponse.videoDetails.videoId
  
  if (forceRefresh || !playerResponse || isExpired || playerResponse.videoDetails?.videoId !== videoId) {
      log('[Content] Page data mismatch, missing, expired, or forced refresh. Fetching page...');
      // Fallback to fetching the page text
      const watchPageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { cache: 'no-store' });
      const watchPageHtml = await watchPageResponse.text();
      const initialDataMatch = watchPageHtml.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
      if (initialDataMatch) {
          playerResponse = JSON.parse(initialDataMatch[1]);
          checkExpiration(playerResponse, 'Fresh Page Response');
      }
  }

  if (!playerResponse) {
    throw new Error('Failed to get player response');
  }

  const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const translationLanguages = playerResponse.captions?.playerCaptionsTracklistRenderer?.translationLanguages || [];

  return {
    originalTracks: captionTracks,
    translationLanguages,
    translatableTracks: captionTracks.filter(t => t.isTranslatable),
    freshPlayerResponse: playerResponse // Expose fresh playerResponse for retry logic
  };
}



async function fetchTranslatedSubtitles(videoId, sourceLang, targetLang, translate) {
  const logs = [];
  const log = (msg) => logs.push(`[Content] ${msg}`);
  
  try {
    log(`Fetching tracks for ${videoId}...`);
    // Step 1: Get available caption tracks
    const tracks = await getCaptionTracks(videoId, log);
    
    // Helper to select track
    const selectTrack = (trackList) => {
        if (sourceLang === 'auto') {
             return trackList.find(t => t.languageCode === 'en') || trackList[0];
        } else {
             return trackList.find(t => t.languageCode === sourceLang);
        }
    };

    let selectedTrack = selectTrack(tracks.originalTracks);

    if (!selectedTrack) {
      // Fallback to first available if specific lang not found
      log(`Track ${sourceLang} not found, using first available.`);
      selectedTrack = tracks.originalTracks[0];
    }

    if (!selectedTrack) {
      throw new Error('Subtitles not found for this video');
    }

    // Helper: Perform the actual fetch and parse
    const performFetch = async (track) => {
        let fetchUrl = '';
        if (translate && track.isTranslatable) {
          fetchUrl = `${track.baseUrl}&tlang=${targetLang}`;
          log(`Fetching translated: ${fetchUrl}`);
        } else {
          fetchUrl = track.baseUrl;
          log(`Fetching original: ${fetchUrl}`);
        }

        const response = await fetch(fetchUrl, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Fetch failed with status ${response.status}`);
        }
        
        let xml = await response.text();

        // Handle empty or invalid response
        if (!xml || xml.trim().length === 0) {
            log(`Empty response from ${fetchUrl}`);
            log(`Status: ${response.status}, Type: ${response.type}`);
            
            // Retry with fmt=json3
            if (!fetchUrl.includes('fmt=')) {
                 log('Empty response, retrying with fmt=json3...');
                 const retryUrl = fetchUrl + '&fmt=json3';
                 const retryResponse = await fetch(retryUrl, { cache: 'no-store' });
                 if (retryResponse.ok) {
                     const jsonText = await retryResponse.text();
                     if (jsonText && jsonText.trim().length > 0) {
                         try {
                             const jsonData = JSON.parse(jsonText);
                             const events = jsonData.events;
                             if (events) {
                                 const data = events
                                    .filter(e => e.segs)
                                    .map(e => ({
                                     start: (e.tStartMs || 0) / 1000,
                                     duration: (e.dDurationMs || 0) / 1000,
                                     text: e.segs.map(s => s.utf8 || '').join('')
                                 }))
                                    .filter(e => e.text.trim().length > 0);
                                 log(`Parsed ${data.length} segments from JSON3.`);
                                 return { data, logs };
                             }
                         } catch (e) {
                             log('Failed to parse JSON3 fallback: ' + e.message);
                         }
                     } else {
                        log('JSON3 fallback also returned empty body');
                     }
                 } else {
                    log(`JSON3 fallback failed with status ${retryResponse.status}`);
                 }
            }
            throw new Error(`Empty response body from YouTube. Status: ${response.status}. URL: ${fetchUrl}`);
        }
        
        // Check if XML is valid
        if (!xml.includes('<transcript>')) {
            log('Response does not look like transcript XML (missing <transcript> tag)');
            log(`Snippet: ${xml.substring(0, 100)}`);
            
            if (xml.trim().length === 0) throw new Error('Received empty string from YouTube caption URL');
            if (xml.includes('Moved Temporarily') || xml.includes('Error')) throw new Error('YouTube returned an error page instead of XML');
        }

        const data = parseTranscriptXml(xml);
        log(`Parsed ${data.length} segments.`);
        
        if (data.length === 0 && xml.includes('<text')) {
             log('Warning: XML has <text> tags but parser found 0 segments. Check parser logic.');
             log(`XML Snippet: ${xml.substring(0, 200)}`);
        }

        return { data, logs };
    };

    // Try fetching with the initially selected track
    try {
        return await performFetch(selectedTrack);
    } catch (e) {
        // Retry logic: If empty response or fetch error, force refresh player response
        if (e.message.includes('Empty response body') || e.message.includes('Fetch failed') || e.message.includes('YouTube returned an error page')) {
             log(`[Retry] First attempt failed: ${e.message}. Refreshing player response...`);
             
             // Fetch fresh page
             const watchPageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { cache: 'no-store' });
             const watchPageHtml = await watchPageResponse.text();
             const initialDataMatch = watchPageHtml.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
             
             if (initialDataMatch) {
                 const newPlayerResponse = JSON.parse(initialDataMatch[1]);
                 const newTracks = newPlayerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                 
                 // Re-select track from new list
                 // Try to match by languageCode and kind
                 let newTrack = newTracks.find(t => t.languageCode === selectedTrack.languageCode && t.kind === selectedTrack.kind);
                 
                 // If not found, try by languageCode only
                 if (!newTrack) {
                     newTrack = newTracks.find(t => t.languageCode === selectedTrack.languageCode);
                 }

                 // If still not found, fallback to first available
                 if (!newTrack && newTracks.length > 0) {
                     newTrack = newTracks[0];
                 }

                 if (newTrack) {
                     log('[Retry] Found fresh track. Retrying fetch...');
                     return await performFetch(newTrack);
                 } else {
                     log('[Retry] Could not find track in fresh response.');
                 }
             } else {
                 log('[Retry] Failed to parse fresh player response.');
             }
        }
        throw e;
    }
  } catch (err) {
    const error = new Error(err.message);
    error.logs = logs;
    throw error;
  }
}

async function getBestCaptionUrl(videoId, sourceLang, targetLang, translate, forceRefresh = false) {
  const logs = [];
  const log = (msg) => logs.push(`[Content] ${msg}`);
  
  try {
    log(`Getting best caption URL for ${videoId}...`);
    
    // Step 1: Get available caption tracks
    const tracks = await getCaptionTracks(videoId, log, forceRefresh);
    
    // Helper to select track
    const selectTrack = (trackList) => {
        if (sourceLang === 'auto') {
             return trackList.find(t => t.languageCode === 'en') || trackList[0];
        } else {
             return trackList.find(t => t.languageCode === sourceLang);
        }
    };

    let selectedTrack = selectTrack(tracks.originalTracks);

    if (!selectedTrack) {
      log(`Track ${sourceLang} not found, using first available.`);
      selectedTrack = tracks.originalTracks[0];
    }

    if (!selectedTrack) {
      throw new Error('Subtitles not found for this video');
    }

    // Construct URL
    let fetchUrl = selectedTrack.baseUrl;
    if (translate && selectedTrack.isTranslatable) {
        fetchUrl += `&tlang=${targetLang}`;
        log(`Selected translated URL: ${fetchUrl}`);
    } else {
        log(`Selected original URL: ${fetchUrl}`);
    }
    
    // Ensure json3
    if (!fetchUrl.includes('fmt=')) {
        fetchUrl += '&fmt=json3';
    } else {
        fetchUrl = fetchUrl.replace(/fmt=[^&]+/, 'fmt=json3');
    }

    return { url: fetchUrl, logs };
  } catch (e) {
    throw { message: e.message, logs };
  }
}

function parseTranscriptXml(xml) {
  // Simple regex parser as DOMParser might be flaky in some contexts (though usually fine in content script)
  // But we want robust parsing
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const textNodes = doc.querySelectorAll('text');
  
  return Array.from(textNodes).map(node => ({
    start: parseFloat(node.getAttribute('start')),
    duration: parseFloat(node.getAttribute('dur')),
    text: node.textContent
  }));
}
