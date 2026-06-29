// === NETWORK SNIFFER ===
// Injected into MAIN world to intercept fetch/XHR
// Captures URLs with timedtext (subtitles)
// Also captures full timedtext response bodies when in embed iframes
// Runs in YouTube page context (including embed iframes via all_frames)

(function() {
    'use strict';

    // Save original functions immediately (before other extensions)
    const _fetch = window.fetch;
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;

    // Captured response bodies keyed by URL
    const capturedResponses = new Map();

    // Check if URL is a subtitle URL
    function isTimedTextUrl(url) {
        return typeof url === 'string' && url.includes('timedtext');
    }

    // Check if we're in an iframe
    const isInIframe = window !== window.top;

    // Extract videoId, lang from timedtext URL
    function parseTimedTextUrl(url) {
        try {
            const urlObj = new URL(url, 'https://www.youtube.com');
            const videoId = urlObj.searchParams.get('v');
            const lang = urlObj.searchParams.get('lang');
            const tlang = urlObj.searchParams.get('tlang');
            const hl = urlObj.searchParams.get('hl');
            const caps = urlObj.searchParams.get('caps');
            const kind = urlObj.searchParams.get('kind');

            let finalLang = lang;
            if (!finalLang) {
                if (kind === 'asr' || caps === 'asr') {
                    finalLang = 'unknown-asr';
                } else {
                    finalLang = hl || 'unknown';
                }
            }

            return { videoId, lang: finalLang, tlang, url };
        } catch (e) {
            return null;
        }
    }

    // Save captured URL (lightweight - for initial Tier 0 URL capture)
    function captureUrl(url) {
        const parsed = parseTimedTextUrl(url);
        if (!parsed || !parsed.videoId) return;

        const { videoId, lang } = parsed;

        window.postMessage({
            type: 'YTSUB_CAPTURED_URL',
            videoId,
            lang: lang || 'unknown',
            url,
            timestamp: Date.now()
        }, '*');

        console.log(`[YTSub Sniffer] Captured URL: video=${videoId}, lang=${lang || 'unknown'}`);
    }

    // Save captured transcript body and relay to parent
    function captureTranscriptBody(url, text) {
        if (!text || text.trim().length === 0) return;

        const parsed = parseTimedTextUrl(url);
        if (!parsed || !parsed.videoId) return;

        const { videoId, lang, tlang } = parsed;

        // Store locally
        capturedResponses.set(url, { videoId, lang, text, timestamp: Date.now() });

        // Store in a global that persists across document_start → document_idle gap.
        // The content script (ISOLATED world, document_idle) reads this global
        // to get transcripts that were captured before its message listener existed.
        if (!window.__ytsub_captured_transcripts) {
            window.__ytsub_captured_transcripts = {};
        }
        if (!window.__ytsub_captured_transcripts[videoId]) {
            window.__ytsub_captured_transcripts[videoId] = {};
        }
        if (!window.__ytsub_captured_transcripts[videoId][lang || 'unknown']) {
            window.__ytsub_captured_transcripts[videoId][lang || 'unknown'] = [];
        }
        window.__ytsub_captured_transcripts[videoId][lang || 'unknown'].push({
            text: text,
            timestamp: Date.now()
        });
        // Keep only the latest capture per video/lang
        if (window.__ytsub_captured_transcripts[videoId][lang || 'unknown'].length > 1) {
            window.__ytsub_captured_transcripts[videoId][lang || 'unknown'] =
                window.__ytsub_captured_transcripts[videoId][lang || 'unknown'].slice(-1);
        }

        const message = {
            type: 'YTSUB_CAPTURED_TRANSCRIPT',
            videoId,
            lang: lang || 'unknown',
            tlang: tlang || null,
            text,
            url,
            timestamp: Date.now()
        };

        // If in iframe, relay to parent frame
        if (isInIframe) {
            window.parent.postMessage(message, '*');
        } else {
            window.postMessage(message, '*');
        }

        console.log(`[YTSub Sniffer] Captured transcript: video=${videoId}, lang=${lang || 'unknown'}, ${text.length} bytes`);
    }

    // Intercept fetch - capture both URL and response body
    window.fetch = async function(...args) {
        const input = args[0];
        const url = input?.url || input || '';

        if (isTimedTextUrl(url)) {
            captureUrl(url);
        }

        // Make the original fetch
        const response = await _fetch.apply(this, args);

        // If it's a timedtext URL, clone and read the response body
        if (isTimedTextUrl(url)) {
            const contentType = response.headers?.get?.('content-type') || '';
            // Only attempt to read text responses
            if (!contentType.includes('audio') && !contentType.includes('video') && !contentType.includes('octet-stream')) {
                try {
                    const clonedResponse = response.clone();
                    const text = await clonedResponse.text();
                    if (text && text.trim().length > 0) {
                        captureTranscriptBody(url, text);
                    }
                } catch (e) {
                    // Clone may fail for streamed responses, ignore
                    console.log(`[YTSub Sniffer] Could not clone response: ${e.message}`);
                }
            }
        }

        return response;
    };

    // Intercept XMLHttpRequest - capture response bodies
    const xhrListeners = new WeakMap();

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._sniffer_url = typeof url === 'string' ? url : (url?.url || '');
        this._sniffer_isTimedText = isTimedTextUrl(this._sniffer_url);

        if (this._sniffer_isTimedText) {
            captureUrl(this._sniffer_url);
        }

        return _xhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        if (this._sniffer_isTimedText) {
            // Remove old listener if any
            const existing = xhrListeners.get(this);
            if (existing) {
                this.removeEventListener('load', existing);
            }

            const handler = () => {
                try {
                    const text = this.responseText;
                    if (text && text.trim().length > 0) {
                        captureTranscriptBody(this._sniffer_url, text);
                    }
                } catch (e) {
                    // XHR may not have responseText available
                }
            };

            xhrListeners.set(this, handler);
            this.addEventListener('load', handler);
        }

        return _xhrSend.apply(this, args);
    };

    // === MAIN WORLD FETCHER ===
    // Handler for fetch requests from content script
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;

        const { type, url, requestId } = event.data || {};

        if (type === 'REQUEST_MAIN_WORLD_FETCH') {
            console.log(`[YTSub Sniffer] Main World Fetch request: ${url.substring(0, 100)}...`);

            try {
                const response = await _fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/xml, text/xml, */*'
                    }
                });

                const text = await response.text();

                window.postMessage({
                    type: 'MAIN_WORLD_FETCH_RESPONSE',
                    requestId,
                    success: true,
                    status: response.status,
                    statusText: response.statusText,
                    body: text,
                    url: response.url
                }, '*');

                console.log(`[YTSub Sniffer] Main World Fetch success: ${response.status}, ${text.length} bytes`);
            } catch (error) {
                window.postMessage({
                    type: 'MAIN_WORLD_FETCH_RESPONSE',
                    requestId,
                    success: false,
                    error: error.message || 'Unknown error'
                }, '*');

                console.error(`[YTSub Sniffer] Main World Fetch error:`, error);
            }
        }
    });

    console.log(`[YTSub Sniffer] Initialized in MAIN world (iframe=${isInIframe})`);

    // If in an iframe, mute everything, wait for the player, toggle captions
    if (isInIframe) {
        // Mute any existing video/audio elements immediately
        document.querySelectorAll('video, audio').forEach(el => { el.muted = true; el.volume = 0; });
        // Watch for dynamically created media elements and mute them
        const muteObserver = new MutationObserver(() => {
            document.querySelectorAll('video, audio').forEach(el => { el.muted = true; el.volume = 0; });
        });
        muteObserver.observe(document.documentElement, { childList: true, subtree: true });

        // Wait for player then toggle captions to trigger timedtext request
        let attempts = 0;
        const tryToggleCaptions = setInterval(() => {
            attempts++;
            const player = document.getElementById('movie_player');
            if (player && typeof player.toggleSubtitles === 'function') {
                clearInterval(tryToggleCaptions);
                player.toggleSubtitles(true);
                console.log('[YTSub Sniffer] Toggled captions ON in iframe');
            } else if (attempts >= 50) {
                clearInterval(tryToggleCaptions);
                console.log('[YTSub Sniffer] Could not find player after 10s');
            }
        }, 200);
    }
})();
