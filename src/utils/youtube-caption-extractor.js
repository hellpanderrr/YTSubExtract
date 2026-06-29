import he from 'he';
import striptags from 'striptags';

// Universal logger
const createLogger = (namespace) => {
  return (message, ...args) => {
    console.log(`[${namespace}] ${message}`, ...args);
  };
};

const debug = createLogger('youtube-caption-extractor');

// YouTube InnerTube API configuration
const INNERTUBE_CONFIG = {
  API_BASE: 'https://www.youtube.com/youtubei/v1',
  API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  CLIENT: {
    WEB: {
      NAME: 'WEB',
      VERSION: '2.20260428.00.00',
    },
    MWEB: {
      NAME: 'MWEB',
      VERSION: '2.20260428.00.00',
      USER_AGENT: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      CLIENT_ID: '2',
    },
    WEB_EMBEDDED: {
      NAME: 'WEB_EMBEDDED_PLAYER',
      VERSION: '2.20260428.00.00',
      CLIENT_ID: '56',
    },
    ANDROID: {
      NAME: 'ANDROID',
      VERSION: '21.16.256',
      USER_AGENT: 'com.google.android.youtube/21.16.256 (Linux; U; Android 15; US; Pixel 9 Build/AP4A.250205.002)',
      CLIENT_ID: '3',
    },
    IOS: {
      NAME: 'IOS',
      VERSION: '20.46.2',
      USER_AGENT: 'com.google.ios.youtube/20.46.2 (iPhone17,2; iOS 18.4.1; scale/3.00)',
      CLIENT_ID: '5',
    },
    TVHTML5: {
      NAME: 'TVHTML5',
      VERSION: '7.20260428.10.00',
      USER_AGENT: 'Mozilla/5.0 (Chromecast; GoogleTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      CLIENT_ID: '7',
    }
  },
};

// Generate proper session data
export async function generateSessionData(clientType = 'IOS') {
  const visitorData = await getCachedVisitorData();
  
  const clientConfig = INNERTUBE_CONFIG.CLIENT[clientType];

  // Base client properties
  const baseClient = {
    hl: 'en',
    gl: 'US',
    clientName: clientConfig.NAME,
    clientVersion: clientConfig.VERSION,
    visitorData,
  };

  // Client-specific additions
  const clientAdditions = {
    ANDROID: { androidSdkVersion: 34 },
    IOS: { osName: 'iOS', osVersion: '18.4.1.22E252', deviceMake: 'Apple', deviceModel: 'iPhone17,2' },
    TVHTML5: { 
      tvAppInfo: { appQuality: 'LARGE' },
      clientScreen: 'WATCH'
    },
    WEB: {
      configInfo: { appInstallData: '' }
    },
    MWEB: {
      platform: 'MOBILE',
      configInfo: { appInstallData: '' }
    },
    WEB_EMBEDDED: {
      configInfo: { appInstallData: '' }
    }
  };

  return {
    context: {
      client: {
        ...baseClient,
        ...(clientAdditions[clientType] || {})
      },
      user: {
        lockedSafetyMode: false,
      },
      request: {
        useSsl: true,
      },
    },
    visitorData,
  };
}

function generateVisitorData() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 11; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Cache visitorData for 24 hours to avoid looking like a bot
let cachedVisitorData = null;
let cachedVisitorDataTimestamp = 0;

export async function getCachedVisitorData() {
  const now = Date.now();
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  
  if (cachedVisitorData && (now - cachedVisitorDataTimestamp) < CACHE_DURATION) {
    return cachedVisitorData;
  }
  
  // Generate new visitorData
  cachedVisitorData = generateVisitorData();
  cachedVisitorDataTimestamp = now;
  
  return cachedVisitorData;
}

export async function fetchInnerTube(endpoint, data, clientType = 'IOS', timeoutMs = 10000, parseAs = 'json') {
  const clientConfig = INNERTUBE_CONFIG.CLIENT[clientType];

  if (!clientConfig) {
    throw new Error(`Invalid client type: ${clientType}`);
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Youtube-Client-Version': clientConfig.VERSION,
    'X-Youtube-Client-Name': clientConfig.CLIENT_ID || '3',
    'X-Goog-Visitor-Id': data.visitorData,
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  };

  // Set User-Agent based on client type.
  // WEB should use the browser's default desktop UA (don't override).
  // Mobile clients (IOS, ANDROID, MWEB, TVHTML5) need their specific UAs.
  if (clientConfig.USER_AGENT) {
    headers['User-Agent'] = clientConfig.USER_AGENT;
  } else if (clientType !== 'WEB') {
    // Fallback generic mobile UA for any mobile client missing a specific one
    headers['User-Agent'] = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  }

  const url = `${INNERTUBE_CONFIG.API_BASE}${endpoint}?key=${INNERTUBE_CONFIG.API_KEY}`;

  debug(`Calling InnerTube endpoint: ${endpoint} with client: ${clientType}`);

  // Add timeout to prevent hanging (covers fetch + body reading)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    // Check for HTTP errors before parsing
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Parse body while AbortController is still active
    let result;
    if (parseAs === 'json') {
      result = await response.json();
    } else {
      result = await response.text();
    }

    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getVideoInfo(videoID) {
  // Helper functions
  const hasCaptions = (d) => d?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length > 0;
  const hasOverlayCaptions = (d) => d?.playerOverlays?.playerOverlayRenderer?.playerOverlayPayload?.playerOverlayCaptionRenderer?.captionTracks?.length > 0;
  const getPlayabilityStatus = (d) => d?.playabilityStatus?.status;
  const isUnplayable = (d) => {
    const status = getPlayabilityStatus(d);
    return status === 'UNPLAYABLE' || status === 'ERROR' || status === 'LOGIN_REQUIRED';
  };

  // Priority: IOS and MWEB often work without PoToken for captions.
  // WEB added because youtubei.js proves it works for metadata.
  // ANDROID deprecated by YouTube in early 2026 for programmatic access.
  const CLIENT_PRIORITY = ['IOS', 'MWEB', 'WEB', 'WEB_EMBEDDED', 'TVHTML5', 'ANDROID'];

  for (const clientType of CLIENT_PRIORITY) {
    try {
      debug(`Trying ${clientType} client...`);

      const sessionData = await generateSessionData(clientType);

      // Build client-specific payload. YouTube strictly validates payload
      // fields per client. Sending Android protobuf params to iOS causes
      // "not available on this app". Sending stale signatureTimestamp to
      // MWEB causes "page needs to be reloaded".
      const payload = {
        context: sessionData.context,
        videoId: videoID,
      };

      if (clientType === 'ANDROID') {
        // ANDROID client requires full legacy payload, but YouTube has
        // deprecated it for programmatic access since early 2026.
        payload.contentCheckOk = true;
        payload.racyCheckOk = true;
        payload.params = 'CgIQBg==';
        payload.playbackContext = {
          contentPlaybackContext: {
            html5Preference: 'HTML5_PREF_WANTS',
            signatureTimestamp: 19894,
            vis: 0,
            splay: false,
            autoCaptionsDefaultOn: false,
            autonavState: 'STATE_NONE',
            lactMilliseconds: '-1',
          },
        };
      } else if (['WEB', 'MWEB', 'WEB_EMBEDDED'].includes(clientType)) {
        // WEB clients need minimal payload.  Adding Android params or
        // playbackContext here triggers playability errors.
        payload.contentCheckOk = true;
        payload.racyCheckOk = true;
      } else if (clientType === 'IOS') {
        // iOS client is very sensitive to extra fields.  Keep it minimal.
        // Do NOT send params or playbackContext.
        payload.contentCheckOk = true;
        payload.racyCheckOk = true;
      } else if (clientType === 'TVHTML5') {
        // TVHTML5 also needs minimal payload.  No Android-specific fields.
        payload.contentCheckOk = true;
        payload.racyCheckOk = true;
      }

      const data = await fetchInnerTube('/player', payload, clientType);

      debug(`${clientType} client response keys: ${Object.keys(data || {}).join(', ')}`);
      if (data?.playabilityStatus) {
        debug(`${clientType} playabilityStatus: ${JSON.stringify(data.playabilityStatus)}`);
      }

      // Fast-fail: if UNPLAYABLE/ERROR/LOGIN_REQUIRED, skip to next client immediately
      if (isUnplayable(data)) {
        debug(`${clientType} returned unplayable status, skipping to next client`);
        continue;
      }

      // Check for captions
      if (hasCaptions(data) || hasOverlayCaptions(data)) {
        debug(`${clientType} client found captions!`);
        return data;
      }

      // If playable but no captions, continue to next client (don't return early)
      const playability = getPlayabilityStatus(data);
      if (playability === 'OK' || playability === 'LIVE_STREAM_OFFLINE') {
        debug(`${clientType}: Video playable but no captions available, trying next client`);
        // Don't return here - let other clients attempt to get captions
      }

    } catch (err) {
      debug(`${clientType} client failed: ${err.message}`);
      // Continue to next client
    }
  }
  
  // All clients failed
  throw new Error(`All InnerTube clients failed for video ${videoID}`);
}

async function getTranscriptFromEngagementPanel(videoID, nextData) {
  if (!nextData?.engagementPanels) {
    debug(` No engagement panels found`);
    return [];
  }

  const transcriptPanel = nextData.engagementPanels.find(
    (panel) =>
      panel?.engagementPanelSectionListRenderer?.panelIdentifier ===
      'engagement-panel-searchable-transcript'
  );

  if (!transcriptPanel) {
    debug(` No transcript engagement panel found`);
    return [];
  }

  const content = transcriptPanel.engagementPanelSectionListRenderer?.content;
  let continuationItem;
  let token;

  continuationItem = content?.continuationItemRenderer;

  if (continuationItem?.continuationEndpoint?.continuationCommand?.token) {
    token = continuationItem.continuationEndpoint.continuationCommand.token;
  } else if (
    continuationItem?.continuationEndpoint?.getTranscriptEndpoint?.params
  ) {
    token = continuationItem.continuationEndpoint.getTranscriptEndpoint.params;
  }

  if (!token && content?.sectionListRenderer?.contents?.[0]) {
    continuationItem =
      content.sectionListRenderer.contents[0].continuationItemRenderer;
    if (continuationItem?.continuationEndpoint?.continuationCommand?.token) {
      token = continuationItem.continuationEndpoint.continuationCommand.token;
    }
  }

  if (!token && content?.sectionListRenderer?.contents) {
    for (const item of content.sectionListRenderer.contents) {
      if (item?.transcriptRenderer) {
        const footer = item.transcriptRenderer.footer;
        if (
          footer?.transcriptFooterRenderer?.languageMenu
            ?.sortFilterSubMenuRenderer?.subMenuItems
        ) {
          const menuItems =
            footer.transcriptFooterRenderer.languageMenu
              .sortFilterSubMenuRenderer.subMenuItems;
          const englishItem =
            menuItems.find(
              (item) =>
                item?.title?.toLowerCase().includes('english') ||
                item?.selected === true
            ) || menuItems[0];

          if (englishItem?.continuation?.reloadContinuationData?.continuation) {
            token =
              englishItem.continuation.reloadContinuationData.continuation;
            break;
          }
        }
      }
    }
  }

  if (!token) {
    debug(` No continuation token found in transcript panel`);
    return [];
  }

  const sessionData = await generateSessionData();
  const transcriptPayload = {
    ...sessionData,
    params: token,
  };

  let transcriptData;
  try {
    transcriptData = await fetchInnerTube(
      '/get_transcript',
      transcriptPayload
    );
  } catch (e) {
    throw new Error(
      `Transcript API failed: ${e.message}`
    );
  }

  if (!transcriptData) {
    throw new Error('Transcript API returned no data');
  }
  const segments =
    transcriptData?.actions?.[0]?.updateEngagementPanelAction?.content
      ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
      ?.transcriptSegmentListRenderer?.initialSegments;

  if (!segments || !Array.isArray(segments)) {
    return [];
  }

  const subtitles = [];

  for (const segment of segments) {
    if (segment.transcriptSegmentRenderer) {
      const renderer = segment.transcriptSegmentRenderer;
      const startMs = parseInt(renderer.startMs || '0');
      const endMs = parseInt(renderer.endMs || '0');
      let text = '';

      if (renderer.snippet?.simpleText) {
        text = renderer.snippet.simpleText;
      } else if (renderer.snippet?.runs) {
        text = renderer.snippet.runs.map((run) => run.text).join('');
      } else if (renderer.snippet?.text) {
        text = renderer.snippet.text;
      }

      if (text.trim()) {
        subtitles.push({
          start: (startMs / 1000).toString(),
          dur: ((endMs - startMs) / 1000).toString(),
          text: he.decode(striptags(text)),
        });
      }
    }
  }

  return subtitles;
}

async function getSubtitlesFromCaptions(videoID, playerData, lang = 'en', options = {}) {
  const { translate, targetLang } = options;

  const captionTracks =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || !Array.isArray(captionTracks)) {
    debug(` No caption tracks found in player data`);
    return [];
  }

  // Find track matching 'lang'
  const subtitle =
    captionTracks.find((track) => track.vssId === `.${lang}`) ||
    captionTracks.find((track) => track.vssId === `a.${lang}`) ||
    captionTracks.find((track) => track.vssId?.includes(`.${lang}`)) ||
    captionTracks[0];

  if (!subtitle?.baseUrl) {
    debug(` No suitable caption track found`);
    return [];
  }

  let captionUrl = subtitle.baseUrl.replace('&fmt=srv3', '');
  
  // Add translation param if requested
  if (translate && targetLang) {
    captionUrl += `&tlang=${targetLang}`;
  }

  const response = await fetch(captionUrl, {
    headers: {
      'User-Agent': INNERTUBE_CONFIG.CLIENT.IOS.USER_AGENT,
      Referer: `https://www.youtube.com/watch?v=${videoID}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Caption fetch failed: ${response.status}`);
  }

  const xmlText = await response.text();

  if (!xmlText.trim() || !xmlText.includes('<text')) {
    throw new Error('Caption content is empty or invalid');
  }

  const startRegex = /start="([\d.]+)"/;
  const durRegex = /dur="([\d.]+)"/;

  return extractSubtitlesFromXML(xmlText, startRegex, durRegex);
}

function extractSubtitlesFromXML(transcript, startRegex, durRegex) {
  return transcript
    .replace('<?xml version="1.0" encoding="utf-8" ?><transcript>', '')
    .replace('</transcript>', '')
    .split('</text>')
    .filter((line) => line && line.trim())
    .reduce((acc, line) => {
      const startResult = startRegex.exec(line);
      const durResult = durRegex.exec(line);

      if (!startResult || !durResult) {
        return acc;
      }

      const [, start] = startResult;
      const [, dur] = durResult;

      const htmlText = line
        .replace(/<text.+>/, '')
        .replace(/&amp;/gi, '&')
        .replace(/<\/?[^>]+(>|$)/g, '');
      const decodedText = he.decode(htmlText);
      const text = striptags(decodedText);

      acc.push({
        start,
        dur,
        text,
      });

      return acc;
    }, []);
}

export async function getLanguages(videoId) {
  try {
    const data = await getVideoInfo(videoId);
    
    // Check for captions in player response
    const playerCaptions = data?.captions?.playerCaptionsTracklistRenderer;
    let captionTracks = playerCaptions?.captionTracks;

    if (!captionTracks) {
        debug(`[getLanguages] No captionTracks in playerCaptionsTracklistRenderer. Keys: ${Object.keys(data?.captions || {}).join(', ')}`);
    } else {
        debug(`[getLanguages] Found ${captionTracks.length} tracks in standard location.`);
    }
    
    // Fallback: Check inside playerOverlays (common in Android/Mobile)
    if (!captionTracks) {
        const playerOverlay = data?.playerOverlays?.playerOverlayRenderer;
        if (playerOverlay) {
             const payload = playerOverlay.playerOverlayPayload || playerOverlay;
             if (payload.playerOverlayCaptionRenderer) {
                 captionTracks = payload.playerOverlayCaptionRenderer.captionTracks;
                 debug(`[getLanguages] Found ${captionTracks.length} tracks in playerOverlay.`);
             } else {
                 debug(`[getLanguages] playerOverlay present but no caption renderer. Keys: ${Object.keys(payload).join(', ')}`);
             }
        } else {
             debug(`[getLanguages] No playerOverlayRenderer found.`);
        }
    }

    if (captionTracks && captionTracks.length > 0) {
        return {
            languages: captionTracks.map(track => {
                const langCode = track.languageCode;
                const langName = track.name?.simpleText || track.name?.runs?.[0]?.text || langCode;
                return {
                    languageCode: langCode,
                    languageName: langName,
                    kind: track.kind
                };
            }),
            title: data.videoDetails?.title
        };
    }

    throw new Error('No caption tracks found in API response');
  } catch (err) {
    debug('Error fetching languages', err);
    throw err;
  }
}

export const getSubtitles = async ({ videoID, lang = 'en', translate, translateLang }) => {
  try {
    const data = await getVideoInfo(videoID);
    
    // Check for captions in player response
    let captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks) {
    // Fallback: Check inside playerOverlays (common in Android/Mobile)
    const playerOverlay = data?.playerOverlays?.playerOverlayRenderer;
    if (playerOverlay) {
        const payload = playerOverlay.playerOverlayPayload || playerOverlay;
        if (payload.playerOverlayCaptionRenderer) {
            captionTracks = payload.playerOverlayCaptionRenderer.captionTracks;
        }
    }
  }

  // Fallback for iOS structure
  if (!captionTracks && data?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      captionTracks = data.captions.playerCaptionsTracklistRenderer.captionTracks;
  }

  if (!captionTracks || !Array.isArray(captionTracks)) {
    debug('No caption tracks found in response keys:', Object.keys(data));
    if (data.playabilityStatus) {
        debug('Playability Status:', data.playabilityStatus.status);
    }
    throw new Error('No captions found');
  }

    let track;
    if (lang === 'auto') {
        track = captionTracks[0];
    } else {
        track = captionTracks.find((t) => t.languageCode === lang);
    }

    if (!track) {
        throw new Error(`Language ${lang} not found`);
    }

    let url = track.baseUrl;
    if (translate && translateLang) {
        url += `&tlang=${translateLang}`;
    }

    const response = await fetch(url);
    const xml = await response.text();
    
    // Parse XML to segments...
     // Chrome Service Workers do not have DOMParser. We need a simple XML parser or regex.
     
     const segments = [];
     const regex = /<text start="([\d.]+)" dur="([\d.]+)".*?>(.*?)<\/text>/g;
     let match;
     while ((match = regex.exec(xml)) !== null) {
         segments.push({
             start: parseFloat(match[1]),
             duration: parseFloat(match[2]),
             text: he.decode(match[3])
         });
     }
     
     return segments;

   } catch (err) {
       debug('Error getting subtitles:', err);
       throw err;
   }
};

// ─────────────────────────────────────────────────────────────
// ANDROID API Bypass for Batch Transcripts
// ANDROID client often works without PoToken for /get_transcript.
// Uses player endpoint with ANDROID context to get params,
// then calls get_transcript to bypass the 0-byte timedtext issue.
// ─────────────────────────────────────────────────────────────
export async function getTranscriptViaAndroid(videoId, lang = 'auto', options = {}) {
  const { translate, translateLang } = options;
  debug(`[AndroidBypass] Fetching transcript for ${videoId}`);

  // Step 1: Call /player with ANDROID client to get caption tracks
  const sessionData = await generateSessionData('ANDROID');
  const playerPayload = {
    context: sessionData.context,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    params: 'CgIQBg==',
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        signatureTimestamp: 19894,
        vis: 0,
        splay: false,
        autoCaptionsDefaultOn: false,
        autonavState: 'STATE_NONE',
        lactMilliseconds: '-1',
      },
    },
  };

  const playerData = await fetchInnerTube('/player', playerPayload, 'ANDROID');

  if (!playerData) {
    throw new Error('Android player response empty');
  }

  // Extract caption tracks (check both standard and overlay locations)
  let captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    const overlay = playerData?.playerOverlays?.playerOverlayRenderer;
    if (overlay?.playerOverlayPayload?.playerOverlayCaptionRenderer?.captionTracks) {
      captionTracks = overlay.playerOverlayPayload.playerOverlayCaptionRenderer.captionTracks;
    } else if (overlay?.playerOverlayCaptionRenderer?.captionTracks) {
      captionTracks = overlay.playerOverlayCaptionRenderer.captionTracks;
    }
  }

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error('No caption tracks in Android player response');
  }

  // Step 2: Select track by language
  let track;
  if (lang && lang !== 'auto') {
    track = captionTracks.find(t => t.languageCode === lang);
  }
  if (!track) {
    track = captionTracks.find(t => t.languageCode === 'en') || captionTracks[0];
  }

  const trackLang = track.languageCode;
  debug(`[AndroidBypass] Selected track: ${trackLang}`);

  // Step 3: Extract getTranscriptEndpoint params from the caption track
  let params = track?.getTranscriptEndpoint?.params;
  if (!params) params = track?.params;

  if (params) {
    // Call /get_transcript with params from player response
    debug(`[AndroidBypass] Using getTranscriptEndpoint.params`);
    const transcriptSession = await generateSessionData('ANDROID');
    const transcriptPayload = {
      context: transcriptSession.context,
      params,
    };

    const transcriptData = await fetchInnerTube('/get_transcript', transcriptPayload, 'ANDROID');

    // Parse segments from the transcript response
    const segments = parseTranscriptSegments(transcriptData);
    if (segments && segments.length > 0) {
      debug(`[AndroidBypass] Got ${segments.length} segments via getTranscriptEndpoint`);
      return { segments, language: trackLang, source: 'android-bypass-gettranscript' };
    }
  }

  // Step 4: Fallback — fetch timedtext URL with ANDROID UA headers
  debug(`[AndroidBypass] Falling back to timedtext URL with ANDROID UA`);
  let url = track.baseUrl;
  if (translate) url += `&tlang=${translateLang}`;
  url += '&fmt=json3';

  const androidUA = INNERTUBE_CONFIG.CLIENT.ANDROID.USER_AGENT;
  const timedtextResp = await fetch(url, {
    headers: {
      'User-Agent': androidUA,
      'Accept': 'application/json, text/plain, */*',
    },
  });

  if (timedtextResp.ok) {
    const text = await timedtextResp.text();
    if (text && text.trim().length > 0) {
      try {
        const json = JSON.parse(text);
        if (json.events && json.events.length > 0) {
          const segs = json.events
            .filter(e => e.segs)
            .map(e => ({
              start: (e.tStartMs || 0) / 1000,
              duration: (e.dDurationMs || 0) / 1000,
              text: e.segs.map(s => s.utf8 || '').join(''),
            }))
            .filter(e => e.text.trim().length > 0);
          if (segs.length > 0) {
            debug(`[AndroidBypass] Got ${segs.length} segments via timedtext URL`);
            return { segments: segs, language: trackLang, source: 'android-bypass-timedtext' };
          }
        }
      } catch (e) {
        debug(`[AndroidBypass] Timedtext parse failed: ${e.message}`);
      }
    }
  }

  throw new Error(`All Android bypass strategies failed for ${videoId}`);
}

// Helper to parse /get_transcript response into segments
function parseTranscriptSegments(data) {
  if (!data) return null;

  // Format 1: actions[0].updateEngagementPanelAction...
  const segments = data?.actions?.[0]?.updateEngagementPanelAction?.content
    ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
    ?.transcriptSegmentListRenderer?.initialSegments;

  if (segments && Array.isArray(segments) && segments.length > 0) {
    return segments.map(segment => {
      const renderer = segment.transcriptSegmentRenderer;
      if (!renderer) return null;
      const startMs = parseInt(renderer.startMs || '0');
      const endMs = parseInt(renderer.endMs || '0');
      let text = '';
      if (renderer.snippet?.simpleText) text = renderer.snippet.simpleText;
      else if (renderer.snippet?.runs) text = renderer.snippet.runs.map(r => r.text).join('');
      else if (renderer.snippet?.text) text = renderer.snippet.text;
      return text.trim() ? {
        start: startMs / 1000,
        duration: (endMs - startMs) / 1000,
        text: he.decode(striptags(text)),
      } : null;
    }).filter(Boolean);
  }

  // Format 2: direct transcriptRenderer (some clients)
  const directData = data?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
    ?.transcriptSegmentListRenderer?.initialSegments;
  if (directData && Array.isArray(directData) && directData.length > 0) {
    return directData.map(segment => {
      const renderer = segment.transcriptSegmentRenderer;
      if (!renderer) return null;
      const startMs = parseInt(renderer.startMs || '0');
      const endMs = parseInt(renderer.endMs || '0');
      let text = '';
      if (renderer.snippet?.simpleText) text = renderer.snippet.simpleText;
      else if (renderer.snippet?.runs) text = renderer.snippet.runs.map(r => r.text).join('');
      else if (renderer.snippet?.text) text = renderer.snippet.text;
      return text.trim() ? {
        start: startMs / 1000,
        duration: (endMs - startMs) / 1000,
        text: he.decode(striptags(text)),
      } : null;
    }).filter(Boolean);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// /next Endpoint → Engagement Panel → Transcript Extraction
// Calls /youtubei/v1/next (not /player) to get engagement panels,
// then extracts transcript via the engagement panel's continuation
// token or getTranscriptEndpoint.params.
// ─────────────────────────────────────────────────────────────
export async function getTranscriptViaNext(videoId, lang = 'auto', options = {}) {
  const log = createLogger('youtube-caption-extractor');

  log(`[NextBypass] Fetching /next for ${videoId}`);
  const sessionData = await generateSessionData('IOS');
  const nextPayload = { ...sessionData, videoId };
  const nextData = await fetchInnerTube('/next', nextPayload, 'IOS');
  if (!nextData) throw new Error('/next returned empty');

  const transcriptPanel = nextData?.engagementPanels?.find(
    p => p?.engagementPanelSectionListRenderer?.panelIdentifier === 'engagement-panel-searchable-transcript'
  );
  if (!transcriptPanel) throw new Error('No transcript engagement panel');

  const content = transcriptPanel.engagementPanelSectionListRenderer?.content;
  let token;
  const contItem = content?.continuationItemRenderer;
  if (contItem?.continuationEndpoint?.continuationCommand?.token) {
    token = contItem.continuationEndpoint.continuationCommand.token;
  } else if (contItem?.continuationEndpoint?.getTranscriptEndpoint?.params) {
    token = contItem.continuationEndpoint.getTranscriptEndpoint.params;
  }
  if (!token && content?.sectionListRenderer?.contents?.[0]) {
    const item = content.sectionListRenderer.contents[0].continuationItemRenderer;
    if (item?.continuationEndpoint?.continuationCommand?.token) token = item.continuationEndpoint.continuationCommand.token;
  }
  if (!token) throw new Error('No transcript token');

  const transcriptSession = await generateSessionData('IOS');
  const transcriptData = await fetchInnerTube('/get_transcript', { ...transcriptSession, params: token }, 'IOS');
  if (!transcriptData) throw new Error('/get_transcript returned empty');

  const segments = parseTranscriptSegments(transcriptData);
  if (segments && segments.length > 0) {
    log(`[NextBypass] Got ${segments.length} segments`);
    return { segments, language: 'unknown', source: 'tier-next-bypass' };
  }
  throw new Error('Parsed 0 segments');
}
