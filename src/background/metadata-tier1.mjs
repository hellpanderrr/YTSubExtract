
// Lightweight metadata fetcher based on youtube-caption-extractor logic
// This avoids loading the heavy youtubei.js library just for metadata

const INNERTUBE_CONFIG = {
    API_BASE: 'https://www.youtube.com/youtubei/v1',
    API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    CLIENT: {
        NAME: 'WEB',
        VERSION: '2.20260215.00.00', // Updated to 2026
    },
};

function generateVisitorData() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let result = '';
    for (let i = 0; i < 11; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateSessionData() {
    const visitorData = generateVisitorData();
    return {
        context: {
            client: {
                hl: 'en',
                gl: 'US',
                clientName: INNERTUBE_CONFIG.CLIENT.NAME,
                clientVersion: INNERTUBE_CONFIG.CLIENT.VERSION,
                visitorData,
            },
            user: {
                enableSafetyMode: false,
            },
            request: {
                useSsl: true,
            },
        },
        visitorData, // Internal use
    };
}

async function fetchInnerTube(endpoint, payload, visitorData) {
    const headers = {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Version': INNERTUBE_CONFIG.CLIENT.VERSION,
        'X-Youtube-Client-Name': '1', // WEB client ID
        'X-Goog-Visitor-Id': visitorData,
        // Origin and Referer are handled by DNR rules now
    };

    const url = `${INNERTUBE_CONFIG.API_BASE}${endpoint}?key=${INNERTUBE_CONFIG.API_KEY}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`${endpoint} API failed: ${response.status}`);
    }

    return await response.json();
}

export async function fetchMetadataTier1(videoId) {
    try {
        const sessionData = generateSessionData();
        const visitorData = sessionData.visitorData;
        delete sessionData.visitorData;

        // 1. Try /player endpoint
        const playerPayload = {
            ...sessionData,
            videoId: videoId,
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

        const playerData = await fetchInnerTube('/player', playerPayload, visitorData);
        
        // Check playability
        if (playerData.playabilityStatus?.status === 'LOGIN_REQUIRED') {
            // If login required, we might still get data from /next, but let's log it
            console.warn('Tier 1: LOGIN_REQUIRED in /player');
        }

        let title = playerData.videoDetails?.title;
        let languages = [];

        // Extract Captions from player
        const captionTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        
        if (captionTracks && captionTracks.length > 0) {
            languages = captionTracks.map(track => ({
                code: track.languageCode,
                name: track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode,
                isAuto: track.kind === 'asr',
                isTranslation: false
            }));
        }

        // 2. If no captions or title, try /next endpoint
        if (!title || languages.length === 0) {
            console.log('Tier 1: Missing title or captions in /player, trying /next');
            
            const nextPayload = {
                ...sessionData,
                videoId: videoId,
            };

            const nextData = await fetchInnerTube('/next', nextPayload, visitorData);

            // Extract Title from /next if missing
            if (!title) {
                 const results = nextData.contents?.twoColumnWatchNextResults?.results?.results?.contents;
                 if (results) {
                     const primaryInfo = results.find(c => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
                     if (primaryInfo?.title?.runs?.[0]?.text) {
                         title = primaryInfo.title.runs[0].text;
                     }
                 }
            }

            // Extract Transcripts (Languages) from /next if missing
            if (languages.length === 0 && nextData.engagementPanels) {
                const transcriptPanel = nextData.engagementPanels.find(p => p.engagementPanelSectionListRenderer?.panelIdentifier === 'engagement-panel-searchable-transcript');
                
                if (transcriptPanel) {
                    const content = transcriptPanel.engagementPanelSectionListRenderer.content;
                    const sectionList = content?.sectionListRenderer?.contents;
                    
                    if (sectionList) {
                         const transcriptRendererItem = sectionList.find(i => i.transcriptRenderer);
                         if (transcriptRendererItem) {
                             const footer = transcriptRendererItem.transcriptRenderer.footer;
                             const menuItems = footer?.transcriptFooterRenderer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;
                             
                             if (menuItems) {
                                 languages = menuItems.map(item => ({
                                     code: item.title?.simpleText || item.title?.runs?.[0]?.text, // This is usually the Name, not code. 
                                     
                                     name: item.title?.simpleText || item.title?.runs?.[0]?.text || "Unknown",
                                     isAuto: false, // Hard to tell from menu
                                     isTranslation: false
                                 }));
                                 
                                 // NOTE: This fallback gives us Names but maybe not Codes. 
                                 // If we return this, the popup will show names. 
                                 // But when user clicks download, we send 'code' to backend.
                                 // If 'code' is the name (e.g. "English"), fetchTier1/2/3 might fail if they expect "en".
                                 // youtube-caption-extractor expects 'lang' code.
                                 
                                 // So this fallback for languages is risky if we can't extract the code.
                                 // Let's clear languages if we can't get real codes.
                                 console.warn('Tier 1: Found transcript menu but cannot reliably extract language codes. Ignoring.');
                                 languages = []; 
                             }
                         }
                    }
                }
            }
        }

        if (!title) title = 'Unknown Video';

        // Sort: manual first
        languages.sort((a, b) => {
            if (a.isAuto === b.isAuto) return 0;
            return a.isAuto ? 1 : -1;
        });

        return {
            title,
            languages
        };

    } catch (error) {
        console.error('Tier 1 Metadata failed:', error);
        throw error;
    }
}
