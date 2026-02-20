import he from 'he';
import striptags from 'striptags';

// Universal logger
const createLogger = (namespace) => {
  return (message, ...args) => {
    // console.log(`[${namespace}] ${message}`, ...args);
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
      VERSION: '2.20260115.00.00', // Updated to 2026
    },
    ANDROID: {
      NAME: 'ANDROID',
      VERSION: '19.35.36',
    },
  },
};

// Generate proper session data
function generateSessionData() {
  const visitorData = generateVisitorData();

  return {
    context: {
      client: {
        hl: 'en',
        gl: 'US',
        clientName: INNERTUBE_CONFIG.CLIENT.ANDROID.NAME,
        clientVersion: INNERTUBE_CONFIG.CLIENT.ANDROID.VERSION,
        visitorData,
        androidSdkVersion: 30
      },
      user: {
        enableSafetyMode: false,
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
  const sessionData = generateSessionData();

  const payload = {
    ...sessionData,
    videoId: videoID,
    playbackContext: {
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: '-1',
      },
    },
    racyCheckOk: true,
    contentCheckOk: true,
  };

  const response = await fetchInnerTube('/player', payload);

  if (!response.ok) {
    throw new Error(
      `Player API failed: ${response.status} ${response.statusText}`
    );
  }

  const playerData = await response.json();

  if (playerData.playabilityStatus?.status === 'LOGIN_REQUIRED') {
    debug(` LOGIN_REQUIRED status, trying next endpoint`);

    const nextPayload = {
      ...sessionData,
      videoId: videoID,
    };

    const nextResponse = await fetchInnerTube('/next', nextPayload);

    if (!nextResponse.ok) {
      throw new Error(
        `Next API failed: ${nextResponse.status} ${nextResponse.statusText}`
      );
    }

    const nextData = await nextResponse.json();
    return { playerData, nextData };
  }

  return { playerData, nextData: null };
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

export const getLanguages = async (videoID) => {
  try {
    const { playerData } = await getVideoInfo(videoID);
    const title = playerData?.videoDetails?.title || 'Unknown Video';
    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || !Array.isArray(captionTracks)) {
      return { languages: [], title };
    }

    const languages = captionTracks.map(track => ({
      languageCode: track.languageCode,
      languageName: track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode,
      kind: track.kind,
      vssId: track.vssId
    }));

    return { languages, title };
  } catch (error) {
    debug('Error getting languages:', error);
    return { languages: [], title: 'Error' };
  }
};

export const getSubtitles = async ({ videoID, lang = 'en', translate, translateLang }) => {
  try {
    const { playerData, nextData } = await getVideoInfo(videoID);

    // Try transcript API first ONLY if not translating (as we don't handle translation there yet)
    if (nextData && !translate) {
      try {
        const subtitles = await getTranscriptFromEngagementPanel(
          videoID,
          nextData
        );
        if (subtitles.length > 0) {
          return subtitles;
        }
      } catch (error) {
        debug('Transcript API failed:', error.message);
      }
    }

    // Fallback to captions (supports translation via &tlang)
    return await getSubtitlesFromCaptions(videoID, playerData, lang, { translate, targetLang: translateLang });
  } catch (error) {
    debug('Error getting subtitles:', error);
    throw error;
  }
};
