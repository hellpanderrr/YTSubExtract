import { generateSessionData, fetchInnerTube } from './youtube-caption-extractor.js';

const createLogger = (namespace) => {
  return (message, ...args) => {
    console.log(`[${namespace}] ${message}`, ...args);
  };
};

const debug = createLogger('playlist-extractor');

/**
 * Main entry point: Extract video list from YouTube playlist
 * Uses background script which tries Tier 0.5 (DOM) first, then API fallback
 * @param {string} playlistId - YouTube playlist ID (e.g., "PL...")
 * @param {number} maxResults - Maximum number of videos to fetch (default: 50)
 * @returns {Promise<{videos: Array<{videoId: string, title: string, duration: string, index: number}>, title: string}>}
 */
export async function fetchPlaylistVideos(playlistId, maxResults = 50) {
  debug(`Fetching playlist via background: ${playlistId}`);

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'GET_PLAYLIST_VIDEOS',
      playlistId,
      maxResults
    }, (response) => {
      if (chrome.runtime.lastError) {
        debug('Runtime error:', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.success) {
        reject(new Error(response?.error || 'Failed to fetch playlist'));
        return;
      }

      debug(`Got ${response.videos?.length || 0} videos from ${response.source || 'unknown'}`);
      resolve({
        videos: response.videos || [],
        title: response.title || ''
      });
    });
  });
}

/**
 * API-only fallback for playlist extraction
 * Used by background script when Tier 0.5 fails
 * @param {string} playlistId - YouTube playlist ID (e.g., "PL...")
 * @param {number} maxResults - Maximum number of videos to fetch (default: 50)
 * @returns {Promise<{videos: Array<{videoId: string, title: string, duration: string, index: number}>, title: string}>}
 */
export async function fetchPlaylistVideosAPI(playlistId, maxResults = 50) {
  maxResults = maxResults || 50; // Guard against undefined/null/0
  const videos = [];
  let pageCount = 0;
  let firstData = null;
  let pageError = null; // declared outside loop to be reachable after it
  const maxPages = Math.ceil(maxResults / 100); // YouTube returns ~100 videos per page

  debug(`Fetching playlist via API: ${playlistId}, maxResults: ${maxResults}`);

  // Try multiple client profiles (WEB first, then IOS, MWEB, WEB_EMBEDDED)
  // WEB returns alerts (e.g. "does not exist") for some playlists like LL
  // that other client profiles serve correctly.
  const CLIENT_PRIORITY = ['WEB', 'IOS', 'MWEB', 'WEB_EMBEDDED', 'TVHTML5'];

  for (const clientType of CLIENT_PRIORITY) {
    videos.length = 0;
    pageCount = 0;
    firstData = null;
    let continuationToken = null;

    try {
      // Generate session data for this client type
      const sessionData = await generateSessionData(clientType);

      while (videos.length < maxResults && pageCount < maxPages) {
        const payload = {
          context: sessionData.context,
          browseId: `VL${playlistId}`,
          ...(continuationToken && {
            continuation: continuationToken
          })
        };

        // Non-WEB clients need standard safety flags
        if (clientType !== 'WEB') {
          payload.contentCheckOk = true;
          payload.racyCheckOk = true;
        }

        debug(`[${clientType}] Fetching page ${pageCount + 1}, current videos: ${videos.length}`);

        let data;
        try {
          data = await fetchInnerTube('/browse', payload, clientType);
        } catch (e) {
          throw new Error(`Browse API failed: ${e.message}`);
        }

        if (!data) {
          throw new Error('Browse API returned no data');
        }
        if (!firstData) firstData = data;

        // Parse videos from response
        const pageVideos = parsePlaylistVideos(data);

        if (pageVideos.length === 0 && !continuationToken) {
          throw new Error('No videos found in playlist');
        }

        debug(`[${clientType}] Found ${pageVideos.length} videos on this page`);

        for (const video of pageVideos) {
          if (videos.length < maxResults) {
            videos.push({
              ...video,
              index: videos.length + 1
            });
          }
        }

        // Check for continuation
        continuationToken = extractContinuationToken(data);

        if (!continuationToken || videos.length >= maxResults) {
          break;
        }

        pageCount++;

        if (continuationToken && pageCount < maxPages) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      if (videos.length > 0) {
        debug(`[${clientType}] Success: ${videos.length} videos`);

        const playlistTitle = extractPlaylistTitle(firstData);
        return { videos, title: playlistTitle };
      }
    } catch (err) {
      pageError = err;
      debug(`[${clientType}] Failed: ${err.message}`);
    }
  }

  // All clients failed
  throw pageError || new Error(`All client profiles failed for playlist ${playlistId}`);
}

/**
 * Extract playlist title from browse response
 */
function extractPlaylistTitle(data) {
  try {
    // Try metadata first (always available)
    const metadata = data?.metadata?.playlistMetadataRenderer;
    if (metadata?.title) {
      return metadata.title;
    }

    // Fallback: try to find title in header
    const header = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer;
    if (header) {
      // Additional header-based title extraction if needed
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

    // Check for alerts at top level first (private playlist, auth required)
    const topLevelAlert = data?.alerts?.[0]?.alertRenderer;
    if (topLevelAlert) {
      debug('Top-level alert found:', JSON.stringify(topLevelAlert));
      const alertText = topLevelAlert.text?.simpleText || topLevelAlert.text?.runs?.map(r => r.text).join('');
      if (alertText) {
        throw new Error(`Playlist unavailable: ${alertText}`);
      }
    }

    // Try twoColumnBrowseResultsRenderer (desktop/WEB)
    const twoColumn = data?.contents?.twoColumnBrowseResultsRenderer;
    // Try singleColumnBrowseResultsRenderer (mobile: IOS, MWEB)
    const singleColumn = data?.contents?.singleColumnBrowseResultsRenderer;

    let contents = null;

    if (twoColumn?.tabs) {
      debug('Found twoColumnBrowseResultsRenderer');
      const videoTab = twoColumn.tabs.find(tab =>
        tab?.tabRenderer?.content?.sectionListRenderer?.contents
      );
      if (videoTab) {
        contents = videoTab.tabRenderer.content.sectionListRenderer.contents;
        debug(`Found ${contents.length} content sections in twoColumn`);
      } else {
        debug('No video tab found in twoColumn, tabs:', twoColumn.tabs.map(t => Object.keys(t || {})));
      }

      // Also check for twoColumn alerts
      const alert = twoColumn?.alerts?.[0]?.alertRenderer;
      if (alert) {
        debug('Alert found in twoColumn:', JSON.stringify(alert));
        const alertText = alert.text?.simpleText || alert.text?.runs?.map(r => r.text).join('');
        if (alertText) {
          throw new Error(`Playlist unavailable: ${alertText}`);
        }
      }
    } else if (singleColumn?.tabs) {
      debug('Found singleColumnBrowseResultsRenderer');
      const videoTab = singleColumn.tabs.find(tab =>
        tab?.tabRenderer?.content?.sectionListRenderer?.contents
      );
      if (videoTab) {
        contents = videoTab.tabRenderer.content.sectionListRenderer.contents;
        debug(`Found ${contents.length} content sections in singleColumn`);
      } else {
        debug('No video tab found in singleColumn, tabs:', singleColumn.tabs.map(t => Object.keys(t || {})));
      }
    }

    // If we found contents, extract videos from them
    if (contents) {
      for (const content of contents) {
        // Try direct playlistVideoListRenderer (current YouTube structure)
        const playlistVideoList =
          content?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer ||
          content?.playlistVideoListRenderer;

        if (playlistVideoList?.contents) {
          const videoItems = playlistVideoList.contents;
          debug(`Found playlistVideoListRenderer with ${videoItems.length} items`);

          for (const item of videoItems) {
            const video = parseVideoRenderer(item?.playlistVideoRenderer);
            if (video) {
              videos.push(video);
            } else {
              // Fallback: try lockupViewModel inside playlistVideoList
              const lockup = item?.lockupViewModel;
              if (lockup) {
                const lv = parseLockupViewModel(lockup);
                if (lv) videos.push(lv);
              }
            }
          }
          continue; // Found videos in this section, move on
        }

        // Fallback: lockupViewModel at itemSection level (new YouTube structure)
        // WEB started rendering playlist items as lockupViewModels
        const itemSectionContents = content?.itemSectionRenderer?.contents || [];
        for (const itemContent of itemSectionContents) {
          if (itemContent?.lockupViewModel) {
            const video = parseLockupViewModel(itemContent.lockupViewModel);
            if (video) {
              videos.push(video);
            }
          } else if (itemContent?.elementRenderer?.type == "lockupViewModel" || itemContent?.elementRenderer?.newElement?.type?.componentType == "lockupViewModel") {
            // Mobile (IOS) sometimes wraps in elementRenderer
            const er = itemContent.elementRenderer;
            const lockup = er?.newElement?.element?.lockupViewModel;
            if (!lockup && er?.newElement?.element) {
              // Try raw element content - YouTube nested format
              const elData = er?.newElement?.element;
              const lv = elData?.lockupViewModel;
              if (!lv) {
                // Deep nested: serialized innerTubeData
                const lv2 = elData?.lockupViewModel;
                if (lv2) {
                  const video = parseLockupViewModel(lv2);
                  if (video) videos.push(video);
                  else debug(`Parsed elementRenderer lockupViewModel but got null`);
                } else {
                  debug(`Unknown elementRenderer content: ${Object.keys(elData).join(', ')}`);
                }
              } else {
                const video = parseLockupViewModel(lv);
                if (video) videos.push(video);
              }
            } else if (lockup) {
              const video = parseLockupViewModel(lockup);
              if (video) videos.push(video);
            } else {
              debug(`elementRenderer has no lockupViewModel, keys: ${Object.keys(er?.newElement?.element || {}).join(', ')}`);
            }
          }
        }

        // Debug: log unrecognized content structure
        const contentKeys = Object.keys(content || {});
        const innerContent = content?.itemSectionRenderer?.contents?.[0];
        if (innerContent && !innerContent.playlistVideoListRenderer) {
          debug(`Unrecognized itemSection content type: ${Object.keys(innerContent).join(', ')}`);
        } else if (!content?.itemSectionRenderer) {
          debug(`Content section type: ${contentKeys.join(', ')}`);
        }
      }
    }

    // Try sidebar (WEB sometimes puts playlist videos in sidebar)
    const sidebarVideos = twoColumn?.sidebar?.playlistSidebarRenderer?.items;
    if (sidebarVideos) {
      debug(`Found sidebar with ${sidebarVideos.length} items`);
      for (const item of sidebarVideos) {
        const secondaryRenderer = item?.playlistSidebarSecondaryInfoRenderer;
        const videoList = secondaryRenderer?.videoOwner?.videoList?.playlistVideoListRenderer?.contents;
        if (videoList) {
          for (const vi of videoList) {
            const video = parseVideoRenderer(vi?.playlistVideoRenderer);
            if (video) {
              videos.push(video);
            }
          }
        }
      }
      if (videos.length > 0) {
        debug(`Extracted ${videos.length} videos from sidebar`);
      }
    } else {
      debug('No tabs found in either twoColumn or singleColumn');

      // Check for continuation items (continuation responses don't have tabs)
      const continuationItems = extractContinuationVideos(data);
      if (continuationItems.length > 0) {
        debug(`Found ${continuationItems.length} videos in continuation response`);
        videos.push(...continuationItems);
      }
    }

    // Also check for continuation items
    const continuationItems = extractContinuationVideos(data);
    videos.push(...continuationItems);

  } catch (err) {
    debug('Error parsing videos:', err);
    // Rethrow playlist availability errors instead of swallowing them
    if (err.message?.startsWith('Playlist unavailable:')) {
      throw err;
    }
  }

  return videos;
}

/**
 * Parse a single playlistVideoRenderer into video object
 * Returns null if invalid
 */
function parseVideoRenderer(videoRenderer) {
  if (!videoRenderer) return null;

  const videoId = videoRenderer.videoId;
  if (!videoId) return null;

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

  return {
    videoId,
    title: title.trim(),
    duration: duration.trim()
  };
}

/**
 * Parse YouTube's new lockupViewModel format
 * YouTube migrated from playlistVideoRenderer to lockupViewModel in 2026
 * for browse/playlist responses.
 *
 * Structure:
 * {
 *   contentId: "videoId",
 *   metadata: { lockupMetadataViewModel: { title: { content: "..." }, metadata: {...} } },
 *   thumbnail: { ... }
 * }
 */
function parseLockupViewModel(lockup) {
  if (!lockup || !lockup.contentId) return null;

  const videoId = lockup.contentId;
  if (typeof videoId !== 'string' || videoId.length < 11) return null;

  // Extract title from metadata
  let title = 'Unknown';
  const metadata = lockup.metadata?.lockupMetadataViewModel;
  if (metadata?.title?.content) {
    title = metadata.title.content;
  } else if (metadata?.title?.simpleText) {
    title = metadata.title.simpleText;
  } else if (typeof lockup.metadata?.title === 'string') {
    title = lockup.metadata.title;
  }

  // Extract duration — try multiple locations
  let duration = '';
  // 1. subtitle field (often "3:15 / 10:30" for playlists)
  if (metadata?.subtitle?.content) {
    const parts = metadata.subtitle.content.split(' / ');
    duration = parts[0] || metadata.subtitle.content;
  }
  // 2. secondary metadata
  if (!duration && metadata?.metadata?.metadataBadgeViewModel?.text) {
    duration = metadata.metadata.metadataBadgeViewModel.text;
  }
  // 3. accessibility label
  if (!duration && lockup.accessibility?.accessibilityData?.label) {
    const label = lockup.accessibility.accessibilityData.label;
    // Try to extract time pattern (e.g. "3 minutes, 15 seconds")
    // Keep empty if we can't parse it, it's non-critical
    duration = label;
  }

  return {
    videoId,
    title: title.trim(),
    duration: duration.trim()
  };
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
        const video = parseVideoRenderer(item?.playlistVideoRenderer);
        if (video) {
          videos.push(video);
        } else {
          const lockup = item?.lockupViewModel;
          if (lockup) {
            const lv = parseLockupViewModel(lockup);
            if (lv) videos.push(lv);
          }
        }
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
    // Helper: try to extract token from a continuation item
    const getToken = (item) => {
      if (!item) return null;
      // continuationItemRenderer (old format)
      if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        return item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      }
      // continuationItemViewModel (new format 2026)
      if (item.continuationItemViewModel?.continuationEndpoint?.continuationCommand?.token) {
        return item.continuationItemViewModel.continuationEndpoint.continuationCommand.token;
      }
      return null;
    };

    // 1. Scan content sections (works for both twoColumn and singleColumn)
    const scanContents = (contents) => {
      if (!contents) return null;
      for (const content of contents) {
        // itemSectionRenderer > contents — last item is often a continuation
        const itemSection = content?.itemSectionRenderer;
        if (itemSection?.contents) {
          const lastInner = itemSection.contents[itemSection.contents.length - 1];
          const token = getToken(lastInner);
          if (token) return token;
        }
        // playlistVideoListRenderer.continuations
        if (content?.playlistVideoListRenderer?.continuations) {
          const cont = content.playlistVideoListRenderer.continuations[0];
          if (cont?.nextContinuationData?.continuation) {
            return cont.nextContinuationData.continuation;
          }
        }
        // continuationItemViewModel at content level
        const token = getToken(content);
        if (token) return token;
      }
      return null;
    };

    // 1a. twoColumn
    const twoCol = data?.contents?.twoColumnBrowseResultsRenderer;
    if (twoCol) {
      const videoTab = twoCol.tabs?.find(tab => tab?.tabRenderer?.content?.sectionListRenderer?.contents);
      if (videoTab) {
        const tok = scanContents(videoTab.tabRenderer.content.sectionListRenderer.contents);
        if (tok) return tok;
      }
    }

    // 1b. singleColumn
    const singleCol = data?.contents?.singleColumnBrowseResultsRenderer;
    if (singleCol) {
      const videoTab = singleCol.tabs?.find(tab => tab?.tabRenderer?.content?.sectionListRenderer?.contents);
      if (videoTab) {
        const tok = scanContents(videoTab.tabRenderer.content.sectionListRenderer.contents);
        if (tok) return tok;
      }
    }

    // 2. In continuation response
    const onResponseReceivedActions = data?.onResponseReceivedActions;
    if (onResponseReceivedActions) {
      for (const action of onResponseReceivedActions) {
        const appendAction = action?.appendContinuationItemsAction;
        if (appendAction?.continuationItems) {
          const lastItem = appendAction.continuationItems[appendAction.continuationItems.length - 1];
          const token = getToken(lastItem);
          if (token) return token;
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
    const hostname = urlObj.hostname.toLowerCase();
    
    // Strict hostname matching to prevent malicious hosts like youtube.com.evil.tld
    const isYouTubeHost =
      hostname === 'youtu.be' ||
      hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtube-nocookie.com' ||
      hostname.endsWith('.youtube-nocookie.com');

    if (!isYouTubeHost) return false;
    
    return urlObj.searchParams.has('list');
  } catch (e) {
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
