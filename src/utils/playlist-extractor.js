import { generateSessionData, fetchInnerTube } from './youtube-caption-extractor.js';

const createLogger = (namespace) => {
  return (message, ...args) => {
    console.log(`[${namespace}] ${message}`, ...args);
  };
};

const debug = createLogger('playlist-extractor');

/**
 * Extract video list from YouTube playlist
 * @param {string} playlistId - YouTube playlist ID (e.g., "PL...")
 * @param {number} maxResults - Maximum number of videos to fetch (default: 50)
 * @returns {Promise<Array<{videoId: string, title: string, duration: string, index: number}>>}
 */
export async function fetchPlaylistVideos(playlistId, maxResults = 50) {
  const videos = [];
  let continuationToken = null;
  let pageCount = 0;
  let lastData = null;
  const maxPages = Math.ceil(maxResults / 100); // YouTube returns ~100 videos per page

  debug(`Fetching playlist: ${playlistId}, maxResults: ${maxResults}`);

  try {
    while (videos.length < maxResults && pageCount < maxPages) {
      const sessionData = generateSessionData('WEB');

      const payload = {
        context: sessionData.context,
        browseId: `VL${playlistId}`,
        ...(continuationToken && {
          continuation: continuationToken
        })
      };

      debug(`Fetching page ${pageCount + 1}, current videos: ${videos.length}`);

      const response = await fetchInnerTube('/browse', payload, 'WEB');

      if (!response.ok) {
        throw new Error(`Browse API failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      lastData = data;

      // Parse videos from response
      const pageVideos = parsePlaylistVideos(data);
      
      if (pageVideos.length === 0 && !continuationToken) {
        // First page has no videos - might be invalid playlist
        throw new Error('No videos found in playlist');
      }

      debug(`Found ${pageVideos.length} videos on this page`);

      // Add to results with global index
      for (const video of pageVideos) {
        if (videos.length < maxResults) {
          videos.push({
            ...video,
            index: videos.length + 1
          });
        }
      }

      debug(`Added ${pageVideos.length} videos, total: ${videos.length}`);

      // Check for continuation
      continuationToken = extractContinuationToken(data);
      
      if (!continuationToken || videos.length >= maxResults) {
        break;
      }

      pageCount++;
      
      // Small delay between pages to be respectful
      if (continuationToken && pageCount < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    debug(`Total videos fetched: ${videos.length}`);

    // Extract playlist title from response
    const playlistTitle = extractPlaylistTitle(lastData);
    debug(`Playlist title: ${playlistTitle}`);

    return { videos, title: playlistTitle };

  } catch (err) {
    debug('Error fetching playlist:', err);
    throw err;
  }
}

/**
 * Extract playlist title from browse response
 */
function extractPlaylistTitle(data) {
  try {
    // Try to find title in header
    const header = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer;
    if (!header) return '';

    // Title might be in the header or we can get it from metadata
    const metadata = data?.metadata?.playlistMetadataRenderer;
    if (metadata?.title) {
      return metadata.title;
    }

    return '';
  } catch (e) {
    return '';
  }
}

/**
 * Parse videos from browse response
 */
function parsePlaylistVideos(data) {
  const videos = [];

  try {
    // Navigate through the nested structure
    debug('Parsing response, top-level keys:', Object.keys(data || {}));

    const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (!tabs) {
      debug('No tabs found. Checking alternative structures...');
      // Try alternative structure (singleColumnBrowseResultsRenderer)
      const singleColumn = data?.contents?.singleColumnBrowseResultsRenderer?.tabs;
      if (singleColumn) {
        debug('Found singleColumnBrowseResultsRenderer');
      }
      // Check for alertRenderer (error message)
      const alert = data?.contents?.twoColumnBrowseResultsRenderer?.alerts?.[0]?.alertRenderer;
      if (alert) {
        debug('Alert found:', JSON.stringify(alert));
      }
      return videos;
    }

    debug(`Found ${tabs.length} tabs`);

    // Find the video list tab
    const videoTab = tabs.find(tab =>
      tab?.tabRenderer?.content?.sectionListRenderer?.contents
    );

    if (!videoTab) {
      debug('No video tab found. Available tabs:', tabs.map(t => Object.keys(t || {})));
      return videos;
    }

    debug('Found video tab');
    const contents = videoTab.tabRenderer.content.sectionListRenderer.contents;
    debug(`Found ${contents.length} content sections`);
    
    for (const content of contents) {
      // Look for itemSectionRenderer with playlistVideoListRenderer
      const itemSection = content?.itemSectionRenderer;
      if (!itemSection) continue;

      const playlistVideoList = itemSection?.contents?.[0]?.playlistVideoListRenderer;
      if (!playlistVideoList) continue;

      const videoItems = playlistVideoList.contents;
      if (!videoItems) continue;

      for (const item of videoItems) {
        const videoRenderer = item?.playlistVideoRenderer;
        if (!videoRenderer) continue;

        const videoId = videoRenderer.videoId;
        if (!videoId) continue;

        // Extract title
        let title = 'Unknown';
        const titleRuns = videoRenderer.title?.runs;
        if (titleRuns && titleRuns.length > 0) {
          title = titleRuns.map(run => run.text).join('');
        } else if (videoRenderer.title?.simpleText) {
          title = videoRenderer.title.simpleText;
        }

        // Extract duration
        let duration = '';
        if (videoRenderer.lengthText?.simpleText) {
          duration = videoRenderer.lengthText.simpleText;
        } else if (videoRenderer.lengthText?.runs) {
          duration = videoRenderer.lengthText.runs.map(run => run.text).join('');
        }

        videos.push({
          videoId,
          title: title.trim(),
          duration: duration.trim()
        });
      }
    }

    // Also check for continuation items
    const continuationItems = extractContinuationVideos(data);
    videos.push(...continuationItems);

  } catch (err) {
    debug('Error parsing videos:', err);
  }

  return videos;
}

/**
 * Extract videos from continuation response
 */
function extractContinuationVideos(data) {
  const videos = [];

  try {
    // Handle continuation response structure
    const onResponseReceivedActions = data?.onResponseReceivedActions;
    if (!onResponseReceivedActions) return videos;

    for (const action of onResponseReceivedActions) {
      const appendAction = action?.appendContinuationItemsAction;
      if (!appendAction) continue;

      const continuationItems = appendAction.continuationItems;
      if (!continuationItems) continue;

      for (const item of continuationItems) {
        const videoRenderer = item?.playlistVideoRenderer;
        if (!videoRenderer) continue;

        const videoId = videoRenderer.videoId;
        if (!videoId) continue;

        let title = 'Unknown';
        const titleRuns = videoRenderer.title?.runs;
        if (titleRuns && titleRuns.length > 0) {
          title = titleRuns.map(run => run.text).join('');
        } else if (videoRenderer.title?.simpleText) {
          title = videoRenderer.title.simpleText;
        }

        let duration = '';
        if (videoRenderer.lengthText?.simpleText) {
          duration = videoRenderer.lengthText.simpleText;
        }

        videos.push({
          videoId,
          title: title.trim(),
          duration: duration.trim()
        });
      }
    }
  } catch (err) {
    debug('Error extracting continuation videos:', err);
  }

  return videos;
}

/**
 * Extract continuation token for pagination
 */
function extractContinuationToken(data) {
  try {
    // Try different locations for continuation token
    
    // 1. In playlistVideoListRenderer.continuations
    const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (tabs) {
      const videoTab = tabs.find(tab => 
        tab?.tabRenderer?.content?.sectionListRenderer?.contents
      );
      
      if (videoTab) {
        const contents = videoTab.tabRenderer.content.sectionListRenderer.contents;
        for (const content of contents) {
          const itemSection = content?.itemSectionRenderer;
          if (itemSection) {
            const playlistVideoList = itemSection?.contents?.[0]?.playlistVideoListRenderer;
            if (playlistVideoList?.continuations) {
              const cont = playlistVideoList.continuations[0];
              if (cont?.nextContinuationData?.continuation) {
                return cont.nextContinuationData.continuation;
              }
            }
          }
        }
      }
    }

    // 2. In continuation response
    const onResponseReceivedActions = data?.onResponseReceivedActions;
    if (onResponseReceivedActions) {
      for (const action of onResponseReceivedActions) {
        const appendAction = action?.appendContinuationItemsAction;
        if (appendAction?.continuationItems) {
          const lastItem = appendAction.continuationItems[appendAction.continuationItems.length - 1];
          if (lastItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
            return lastItem.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
          }
        }
      }
    }

  } catch (err) {
    debug('Error extracting continuation token:', err);
  }

  return null;
}

/**
 * Check if URL is a playlist URL
 */
export function isPlaylistUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('youtube.com') && 
           urlObj.searchParams.has('list') &&
           !urlObj.searchParams.get('list').startsWith('RD'); // Exclude radio mixes
  } catch {
    return false;
  }
}

/**
 * Extract playlist ID from URL
 */
export function extractPlaylistId(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get('list');
  } catch {
    return null;
  }
}
