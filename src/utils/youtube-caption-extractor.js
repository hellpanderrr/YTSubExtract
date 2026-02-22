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
      VERSION: '2.20230628.00.00',
    },
    ANDROID: {
      NAME: 'ANDROID',
      VERSION: '19.29.35',
    },
    IOS: {
      NAME: 'IOS',
      VERSION: '19.45.4',
    }
  },
};

// Generate proper session data
function generateSessionData(clientType = 'ANDROID') {
  const visitorData = generateVisitorData();
  
  const clientConfig = INNERTUBE_CONFIG.CLIENT[clientType];

  return {
    context: {
      client: {
        hl: 'en',
        gl: 'US',
        clientName: clientConfig.NAME,
        clientVersion: clientConfig.VERSION,
        visitorData,
        ...(clientType === 'ANDROID' ? { androidSdkVersion: 34 } : {}),
        ...(clientType === 'IOS' ? { osName: 'iOS', osVersion: '17.5.1.21F90', deviceMake: 'Apple', deviceModel: 'iPhone14,5' } : {})
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

async function fetchInnerTube(endpoint, data) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': 'com.google.android.youtube/19.35.36 (Linux; U; Android 11; US; Pixel 5 Build/RQ3A.210905.001)',
    'X-Youtube-Client-Version': INNERTUBE_CONFIG.CLIENT.ANDROID.VERSION,
    'X-Youtube-Client-Name': '3', // ANDROID client ID is 3
    'X-Goog-Visitor-Id': data.visitorData,
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  };

  const url = `${INNERTUBE_CONFIG.API_BASE}${endpoint}?key=${INNERTUBE_CONFIG.API_KEY}`;

  debug(`Calling InnerTube endpoint: ${endpoint}`);

  return await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

async function getVideoInfo(videoID) {
  const sessionData = generateSessionData('ANDROID');

  const payload = {
    context: sessionData.context,
    videoId: videoID,
    playbackContext: {
        contentPlaybackContext: {
            signatureTimestamp: 19894 // Standard valid timestamp
        }
    }
  };

  const response = await fetchInnerTube('/player', payload);
  if (!response.ok) {
      throw new Error(`InnerTube API failed with status: ${response.status}`);
  }

  const data = await response.json();

  // If no captions in Android, try iOS
  if (!data?.captions?.playerCaptionsTracklistRenderer?.captionTracks && 
      !data?.playerOverlays?.playerOverlayRenderer?.playerOverlayPayload?.playerOverlayCaptionRenderer?.captionTracks) {
        
        debug('Android client returned no captions. Trying iOS client...');
        const iosSession = generateSessionData('IOS');
        const iosPayload = {
            context: iosSession.context,
            videoId: videoID,
            playbackContext: {
                contentPlaybackContext: {
                    signatureTimestamp: 19894
                }
            }
        };

        const iosResponse = await fetchInnerTube('/player', iosPayload);
        if (iosResponse.ok) {
            const iosData = await iosResponse.json();
            if (iosData?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
                debug('iOS client found captions!');
                return iosData;
            } else {
                debug('iOS client also returned no captions.');
            }
        }
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

  const transcriptResponse = await fetchInnerTube(
    '/get_transcript',
    transcriptPayload
  );

  if (!transcriptResponse.ok) {
    throw new Error(
      `Transcript API failed: ${transcriptResponse.status} ${transcriptResponse.statusText}`
    );
  }

  const transcriptData = await transcriptResponse.json();
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
