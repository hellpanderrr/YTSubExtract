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
      VERSION: '2.20260215.00.00',
    },
    ANDROID: {
      NAME: 'ANDROID',
      VERSION: '20.05.41',
      USER_AGENT: 'com.google.android.youtube/20.05.41 (Linux; U; Android 15; US; Pixel 9 Build/AP4A.250205.002)',
      CLIENT_ID: '3',
    },
    IOS: {
      NAME: 'IOS',
      VERSION: '20.04.3',
      USER_AGENT: 'com.google.ios.youtube/20.04.3 (iPhone16,2; iOS 18.2.1; scale/3.00)',
      CLIENT_ID: '5',
    },
    TVHTML5: {
      NAME: 'TVHTML5',
      VERSION: '7.20250401.10.00',
      USER_AGENT: 'Mozilla/5.0 (Chromecast; GoogleTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      CLIENT_ID: '7',
    }
  },
};

// Generate proper session data
export function generateSessionData(clientType = 'ANDROID') {
  const visitorData = generateVisitorData();
  
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
    IOS: { osName: 'iOS', osVersion: '17.5.1.21F90', deviceMake: 'Apple', deviceModel: 'iPhone14,5' },
    TVHTML5: { 
      tvAppInfo: { appQuality: 'LARGE' },
      clientScreen: 'WATCH'
    },
    WEB: {}
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

export async function fetchInnerTube(endpoint, data, clientType = 'ANDROID', timeoutMs = 10000, parseAs = 'json') {
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

  // Set User-Agent based on client type
  if (clientConfig.USER_AGENT) {
    headers['User-Agent'] = clientConfig.USER_AGENT;
  } else {
    headers['User-Agent'] = 'com.google.android.youtube/19.35.36 (Linux; U; Android 11; US; Pixel 5 Build/RQ3A.210905.001)';
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
  // Try Android client first
  const sessionData = generateSessionData('ANDROID');

  const payload = {
    context: sessionData.context,
    videoId: videoID,
    // NEW: Add these flags for guest mode support
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
        contentPlaybackContext: {
            signatureTimestamp: 19894 // Standard valid timestamp
        }
    }
  };

  let data = await fetchInnerTube('/player', payload, 'ANDROID');
  if (!data) {
      throw new Error(`InnerTube API failed: no data returned`);
  }

  // Helper to check if we have captions
  const hasCaptions = (d) => d?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length > 0;
  const hasOverlayCaptions = (d) => d?.playerOverlays?.playerOverlayRenderer?.playerOverlayPayload?.playerOverlayCaptionRenderer?.captionTracks?.length > 0;
  const getPlayabilityStatus = (d) => d?.playabilityStatus?.status;
  
  // Check for captions in Android response
  if (hasCaptions(data) || hasOverlayCaptions(data)) {
    debug('Android client found captions!');
    return data;
  }

  const playabilityStatus = getPlayabilityStatus(data);
  debug(`Android client playability: ${playabilityStatus}`);

  // Try iOS client
  debug('Android client returned no captions. Trying iOS client...');
  const iosSession = generateSessionData('IOS');
  const iosPayload = {
      context: iosSession.context,
      videoId: videoID,
      // NEW: Add these flags for guest mode support
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
          contentPlaybackContext: {
              signatureTimestamp: 19894
          }
      }
  };

  let iosData;
  try {
      iosData = await fetchInnerTube('/player', iosPayload, 'IOS');
  } catch (e) {
      debug(`iOS client failed: ${e.message}`);
      iosData = null;
  }
  if (iosData) {
      if (hasCaptions(iosData) || hasOverlayCaptions(iosData)) {
          debug('iOS client found captions!');
          return iosData;
      }
      debug(`iOS client playability: ${getPlayabilityStatus(iosData)}`);
  }

  // NEW: Try TVHTML5 client for age-restricted videos
  debug('Trying TVHTML5 client for age-restricted video...');
  
  const tvSession = generateSessionData('TVHTML5');
  const tvPayload = {
      context: tvSession.context,
      videoId: videoID,
      contentCheckOk: true,
      racyCheckOk: true
  };

  try {
    const tvData = await fetchInnerTube('/player', tvPayload, 'TVHTML5');
    if (tvData) {
      const tvPlayability = getPlayabilityStatus(tvData);
      
      debug(`TVHTML5 playability: ${tvPlayability}`);
      
      if (hasCaptions(tvData) || hasOverlayCaptions(tvData)) {
        debug('TVHTML5 client found captions! Age bypass successful.');
        return tvData;
      } else if (tvPlayability === 'OK' || tvPlayability === 'LIVE_STREAM_OFFLINE') {
        // Video is playable but no captions
        debug('TVHTML5: Video playable but no captions available');
        return tvData;
      }
    }
  } catch (tvErr) {
    debug(`TVHTML5 client failed: ${tvErr.message}`);
  }

  return data;
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

  const sessionData = generateSessionData();
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
      'User-Agent': 'com.google.android.youtube/19.35.36 (Linux; U; Android 11; US; Pixel 5 Build/RQ3A.210905.001)',
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

    if (captionTracks) {
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

    return { languages: [], title: null };
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
