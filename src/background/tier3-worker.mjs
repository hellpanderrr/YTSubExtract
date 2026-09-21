import { Innertube, UniversalCache } from 'youtubei.js';

// Polyfill for youtubei.js environment detection
if (typeof document === 'undefined') {
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    createElement: () => ({ style: {}, appendChild: () => {} }),
    cookie: '',
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    documentElement: { style: {} }
  };
}
if (typeof window === 'undefined') {
  globalThis.window = globalThis;
  if (!globalThis.window.document) {
    globalThis.window.document = globalThis.document;
  }
}

// Don't cache the Innertube session — create fresh per call.
// YouTube's /player response varies (sometimes includes captions, sometimes not)
// depending on the session's visitorData/poToken state. A fresh session
// with IOS client gives the best chance of getting caption data.

// NOTE: youtubei.js matches client_type against CLIENTS[*].NAME, which is
// 'iOS' (lowercase i), NOT 'IOS' — 'IOS' logs "Unknown client name" and falls
// through to a default session. (Found 2026-09-21 via SW log.)
async function createFreshSession(client = 'iOS') {
  return await Innertube.create({
    lang: 'en',
    location: 'US',
    cache: new UniversalCache(false),
    generate_session_locally: true,
    device_category: 'desktop',
    client_type: client,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

function parseXmlTranscript(xml) {
  const segments = [];
  // Regex to match <text start="X" dur="Y">Content</text>
  // Note: attributes order might vary, but usually start is first.
  // Using a more robust regex or multiple checks.
  // <text start="0.04" dur="2.12">
  
  // Simple regex for standard YouTube XML format
  const textRegex = /<text[^>]*start="([\d\.]+)"[^>]*dur="([\d\.]+)"[^>]*>([^<]*)<\/text>/g;
  
  // Also handle cases where attributes might be different order or missing dur?
  // Usually they are present.
  
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    segments.push({
      start: parseFloat(match[1]),
      end: parseFloat(match[1]) + parseFloat(match[2]),
      text: decodeHTMLEntities(match[3])
    });
  }
  
  if (segments.length === 0) {
      // Try alternative regex if attributes are different
      // e.g. just start
      const textRegex2 = /<text[^>]*start="([\d\.]+)"[^>]*>([^<]*)<\/text>/g;
      while ((match = textRegex2.exec(xml)) !== null) {
          segments.push({
              start: parseFloat(match[1]),
              end: parseFloat(match[1]) + 2.0, // Default duration if missing?
              text: decodeHTMLEntities(match[2])
          });
      }
  }
  
  return segments;
}

function decodeHTMLEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

export async function fetchTier3Transcript(videoId, options = {}) {
  try {
    let lang = 'ru';
    let translate = false;
    let targetLang = 'ru';

    if (typeof options === 'string') {
        lang = options;
    } else {
        lang = options.lang || 'ru';
        translate = options.translate || false;
        targetLang = options.targetLang || 'ru';
    }

    const yt = await createFreshSession('iOS');

    // First, try IOS client for info (best for caption discovery).
    let info;
    try {
        info = await yt.getInfo(videoId);
    } catch (e) {
        console.warn('Tier 3: getInfo (IOS) failed, trying WEB', e.message);
        try {
            const yt2 = await createFreshSession('WEB');
            info = await yt2.getInfo(videoId);
        } catch (e2) {
            console.warn('Tier 3: getInfo (WEB) also failed', e2.message);
            throw e2;
        }
    }

    // 1. Check for caption tracks (Innertube parsed or raw)
    let captionTracks = info.captions?.caption_tracks;

    if (!captionTracks || captionTracks.length === 0) {
         // Fallback to raw player_response if Innertube didn't parse it
         captionTracks = info.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    }

    // 2. If Innertube still has no captions, try direct InnerTube API call
    // with multiple clients AND retries. YouTube's /player response is
    // non-deterministic: sometimes it returns full captions alongside
    // LOGIN_REQUIRED, sometimes a stripped response without captions.
    // Retrying with fresh visitorData increases hit rate.
    if (!captionTracks || captionTracks.length === 0) {
        console.log('[Tier 3] No captions from Innertube, trying direct InnerTube API (with retries)...');
        const clientsToTry = [
            { name: 'IOS', version: '20.46.2', id: '5', ua: 'com.google.ios.youtube/20.46.2 (iPhone17,2; iOS 18.4.1; scale/3.00)', extras: { osName: 'iOS', osVersion: '18.4.1.22E252', deviceMake: 'Apple', deviceModel: 'iPhone17,2' } },
            { name: 'WEB', version: '2.20260428.00.00', id: '1', extras: {} },
            { name: 'ANDROID', version: '21.16.256', id: '3', ua: 'com.google.android.youtube/21.16.256 (Linux; U; Android 15; US; Pixel 9 Build/AP4A.250205.002)', extras: { androidSdkVersion: 34 } },
        ];

        // Try each client up to 3 times with different visitorData
        for (const client of clientsToTry) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const visitorData = Array.from({length: 11}, () =>
                        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
                            .charAt(Math.floor(Math.random() * 63))
                    ).join('');

                    const playerPayload = {
                        context: {
                            client: {
                                hl: 'en', gl: 'US',
                                clientName: client.name,
                                clientVersion: client.version,
                                visitorData,
                                ...client.extras,
                            },
                        },
                        videoId,
                        contentCheckOk: true,
                        racyCheckOk: true,
                        params: 'CgIQBg==',
                    };

                    const headers = {
                        'Content-Type': 'application/json',
                        'X-Youtube-Client-Version': client.version,
                        'X-Youtube-Client-Name': client.id,
                        Origin: 'https://www.youtube.com',
                        Referer: 'https://www.youtube.com/',
                    };
                    if (client.ua) headers['User-Agent'] = client.ua;

                    const resp = await fetch(
                        'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
                        { method: 'POST', headers, body: JSON.stringify(playerPayload) }
                    );
                    if (resp.ok) {
                        const data = await resp.json();
                        const raw = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
                            || data?.playerOverlays?.playerOverlayRenderer?.playerOverlayPayload?.playerOverlayCaptionRenderer?.captionTracks;
                        if (raw?.length > 0) {
                            captionTracks = raw;
                            console.log(`[Tier 3] Found ${raw.length} caption tracks via direct ${client.name} API (attempt ${attempt + 1})`);
                            break;
                        }
                    }
                } catch (e) {
                    console.warn(`[Tier 3] Direct ${client.name} API attempt ${attempt + 1} failed:`, e.message);
                }
            }
            if (captionTracks?.length > 0) break;
        }
    }
    
    if (captionTracks && captionTracks.length > 0) {
        console.log(`[Tier 3] Found ${captionTracks.length} caption tracks`);
        
        let track;
        // Innertube tracks use 'language_code', raw tracks use 'languageCode'
        // We need to handle both
        const getLang = (t) => t.language_code || t.languageCode;
        const getUrl = (t) => t.base_url || t.baseUrl;
        
        if (lang === 'auto') {
             track = captionTracks.find(t => getLang(t) === 'en') || captionTracks[0];
        } else {
             track = captionTracks.find(t => getLang(t) === lang);
        }
        
        if (!track) {
            console.log(`[Tier 3] Track ${lang} not found, using first available`);
            track = captionTracks[0];
        }
        
        if (track) {
            let fetchUrl = getUrl(track);
            if (translate) { // Only append tlang if we want translation
                 fetchUrl += `&tlang=${targetLang}`;
            }
            
            console.log(`[Tier 3] Fetching from URL: ${fetchUrl}`);
            const response = await fetch(fetchUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch caption track: ${response.status}`);
            }
            const xml = await response.text();
            
            // Validate XML
            if (!xml || !xml.includes('<transcript>')) {
                 console.warn('[Tier 3] Invalid XML response:', xml.substring(0, 100));
                 // Don't throw immediately, maybe try getTranscript?
                 // But usually this means we can't get it.
            } else {
                const segments = parseXmlTranscript(xml); 
                
                if (segments && segments.length > 0) {
                     return {
                         segments,
                         language: translate ? targetLang : (getLang(track) || lang),
                         isTranslated: translate
                     };
                }
            }
        }
    }

    // 2. If no caption tracks or failed, try Innertube's getTranscript
    // This uses the engagement panel API which might be blocked (400 Bad Request)
    console.log('[Tier 3] Falling back to Innertube getTranscript...');
    
    try {
        const transcriptData = await info.getTranscript();
        
        if (!transcriptData || !transcriptData.transcript) {
             throw new Error('Transcript data empty');
        }
        
        // ... (rest of processing)
    
        const segments = transcriptData.transcript.content.body.initial_segments.map(seg => {
            return {
                text: seg.snippet.text,
                start: Number(seg.start_ms) / 1000,
                end: Number(seg.end_ms) / 1000
            };
        });
        
        return {
            segments: segments,
            language: lang
        };

    } catch (e) {
         console.warn('[Tier 3] Innertube getTranscript failed:', e);
         throw e; // Propagate error if this also fails
    }

  } catch (error) {
    console.error('Tier 3: fetchTier3Transcript failed', error);
    throw error;
  }
}

export async function getVideoMetadata(videoId) {
  try {
    const yt = await createFreshSession('iOS');
    let info;
    try {
      info = await yt.getInfo(videoId);
    } catch (e) {
      console.warn('Tier 3 Metadata: getInfo (IOS) failed, trying WEB', e.message);
      const yt2 = await createFreshSession('WEB');
      info = await yt2.getInfo(videoId);
    }

    console.log('[Tier 3 Debug] info keys:', Object.keys(info || {}).join(', '));
    console.log('[Tier 3 Debug] info.captions:', info.captions ? '(present)' : 'undefined');
    console.log('[Tier 3 Debug] info.basic_info:', JSON.stringify(info.basic_info, null, 2));

    let languages = [];
    let captionTracks = info.captions?.caption_tracks;

    if (captionTracks && captionTracks.length > 0) {
      languages = captionTracks.map(track => ({
        code: track.language_code,
        name: track.name?.text || track.language_code,
        isAuto: track.kind === 'asr',
        isTranslation: false
      }));
    }

    // Direct API fallback if Innertube had no captions (with retries)
    if (!captionTracks || captionTracks.length === 0) {
      console.log('[Tier 3 Metadata] No captions from Innertube, trying direct API (with retries)...');
      const clients = [
        { name: 'IOS', version: '20.46.2', id: '5', extras: { osName: 'iOS', osVersion: '18.4.1.22E252', deviceMake: 'Apple', deviceModel: 'iPhone17,2' } },
        { name: 'WEB', version: '2.20260428.00.00', id: '1', extras: {} },
        { name: 'ANDROID', version: '21.16.256', id: '3', extras: { androidSdkVersion: 34 } },
      ];
      for (const c of clients) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const vd = Array.from({length: 11}, () =>
              'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(Math.floor(Math.random() * 63))
            ).join('');
            const resp = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Version': c.version, 'X-Youtube-Client-Name': c.id, Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/' },
              body: JSON.stringify({ context: { client: { hl: 'en', gl: 'US', clientName: c.name, clientVersion: c.version, visitorData: vd, ...c.extras } }, videoId, contentCheckOk: true, racyCheckOk: true, params: 'CgIQBg==' }),
            });
            if (resp.ok) {
              const data = await resp.json();
              const raw = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
              if (raw?.length > 0) {
                languages = raw.map(track => ({ code: track.languageCode, name: track.name?.simpleText || track.languageCode, isAuto: track.kind === 'asr', isTranslation: false }));
                console.log(`[Tier 3 Metadata] Found ${languages.length} languages via direct ${c.name} API (attempt ${attempt + 1})`);
                break;
              }
            }
          } catch (e) { /* skip */ }
        }
        if (languages.length > 0) break;
      }
    }

    // Sort: manual first, then auto-generated
    languages.sort((a, b) => {
      if (a.isAuto === b.isAuto) return 0;
      return a.isAuto ? 1 : -1;
    });

    return {
      title: info.basic_info?.title || '',
      languages
    };
  } catch (error) {
    console.error('Tier 3 Metadata Error:', error);
    throw error;
  }
}
