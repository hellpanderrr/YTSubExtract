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
        sendResponse({ success: false, error: err.message });
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
});

// Helper to get player response from page context
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
