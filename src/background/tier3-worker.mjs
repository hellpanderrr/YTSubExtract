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

let innertube = null;

async function getInnertube() {
  if (!innertube) {
    innertube = await Innertube.create({
      lang: 'en',
      location: 'US',
      cache: new UniversalCache(false),
      generate_session_locally: true,
      device_category: 'desktop',
      fetch: (input, init) => globalThis.fetch(input, init)
    });
  }
  return innertube;
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

    const yt = await getInnertube();
    
    // First, try to get info
    let info;
    try {
        info = await yt.getInfo(videoId);
    } catch (e) {
        console.warn('Tier 3: getInfo failed, trying basic client', e);
        // Sometimes basic client works better? 
        // Or maybe videoId is invalid?
        throw e;
    }
    
    // 1. Check for caption tracks (Innertube parsed or raw)
    let captionTracks = info.captions?.caption_tracks;
    
    if (!captionTracks || captionTracks.length === 0) {
         // Fallback to raw player_response if Innertube didn't parse it
         captionTracks = info.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
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
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);

    // DEBUG: Log the full structure
    console.log('[Tier 3 Debug] info keys:', Object.keys(info || {}).join(', '));
    console.log('[Tier 3 Debug] info.captions:', JSON.stringify(info.captions, null, 2));
    console.log('[Tier 3 Debug] info.basic_info:', JSON.stringify(info.basic_info, null, 2));

    let languages = [];
    const captionTracks = info.captions?.caption_tracks;

    if (captionTracks && captionTracks.length > 0) {
        languages = captionTracks.map(track => ({
            code: track.language_code,
            name: track.name.text,
            isAuto: track.kind === 'asr',
            isTranslation: false
        }));
    } else {
        // Fallback: Look for transcript engagement panel
        console.log('Tier 3: No caption tracks, looking for transcript panel...');
        if (info.engagement_panels) {
            const transcriptPanel = info.engagement_panels.find(p => p.content?.model?.payload?.engagementPanelSearchableTranscriptRenderer);
            
            try {
                languages.push({
                    code: 'default', // Special code
                    name: 'Default (Transcript)',
                    isAuto: true,
                    isTranslation: false
                });
            } catch (e) {
                // ignore
            }
        }
    }

    // Sort: manual first, then auto-generated
    languages.sort((a, b) => {
      if (a.isAuto === b.isAuto) return 0;
      return a.isAuto ? 1 : -1;
    });

    return {
      title: info.basic_info.title,
      languages
    };
  } catch (error) {
    console.error('Tier 3 Metadata Error:', error);
    throw error;
  }
}
