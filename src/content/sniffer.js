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

    // Extract videoId, lang, pot token from timedtext URL
    function parseTimedTextUrl(url) {
        try {
            const urlObj = new URL(url, 'https://www.youtube.com');
            const videoId = urlObj.searchParams.get('v');
            const lang = urlObj.searchParams.get('lang');
            const tlang = urlObj.searchParams.get('tlang');
            const hl = urlObj.searchParams.get('hl');
            const caps = urlObj.searchParams.get('caps');
            const kind = urlObj.searchParams.get('kind');
            const pot = urlObj.searchParams.get('pot');
            const visitorData = urlObj.searchParams.get('id') || urlObj.searchParams.get('visitor_data') || null;

            let finalLang = lang;
            if (!finalLang) {
                if (kind === 'asr' || caps === 'asr') {
                    finalLang = 'unknown-asr';
                } else {
                    finalLang = hl || 'unknown';
                }
            }

            return { videoId, lang: finalLang, tlang, url, pot, visitorData };
        } catch (e) {
            return null;
        }
    }

    // Save captured URL (lightweight - for initial Tier 0 URL capture)
    function captureUrl(url) {
        const parsed = parseTimedTextUrl(url);
        if (!parsed || !parsed.videoId) return;

        const { videoId, lang, pot, visitorData } = parsed;

        window.postMessage({
            type: 'YTSUB_CAPTURED_URL',
            videoId,
            lang: lang || 'unknown',
            url,
            pot: pot || null,
            visitorData: visitorData || null,
            timestamp: Date.now()
        }, '*');

        if (pot) {
            console.log(`[YTSub Sniffer] Captured URL with PoToken: video=${videoId}, lang=${lang || 'unknown'}`);
        } else {
            console.log(`[YTSub Sniffer] Captured URL: video=${videoId}, lang=${lang || 'unknown'}`);
        }
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

        // If it's a timedtext URL, clone and read the response body.
        // NOTE: a 200 + 0-byte body is YouTube's PoToken refusal, not an
        // empty transcript — log it verbatim so "withheld" is visible instead
        // of silently dropped (2026-09-20).
        if (isTimedTextUrl(url)) {
            const contentType = response.headers?.get?.('content-type') || '';
            // Only attempt to read text responses
            if (!contentType.includes('audio') && !contentType.includes('video') && !contentType.includes('octet-stream')) {
                try {
                    const clonedResponse = response.clone();
                    const text = await clonedResponse.text();
                    if (text && text.trim().length > 0) {
                        captureTranscriptBody(url, text);
                    } else {
                        console.log(`[YTSub Sniffer] Empty timedtext body: status=${response.status}, video=${parseTimedTextUrl(url)?.videoId || '?'}, lang=${parseTimedTextUrl(url)?.lang || '?'}, content-type=${contentType || 'none'}`);
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

    // Backfill: the ISOLATED content script loads after document_start, so
    // captures that fired early would be invisible to it. It asks for a
    // re-broadcast via postMessage (script injection from ISOLATED world does
    // not execute on youtube.com, so injection-based reads silently fail).
    function backfillTranscripts(requestId) {
        const data = window.__ytsub_captured_transcripts;
        if (!data) return;
        window.postMessage({ type: 'YTSUB_CAPTURED_TRANSCRIPT_BRIDGE', requestId, data }, '*');
    }

    // Player-state probe for the ISOLATED content script (same reason as
    // above: it cannot touch the player's JS API from its own world).
    function probePlayerReady(requestId) {
        const state = { ready: false, hasCaptions: false, hasPlayer: false,
            trackCount: 0, tracks: [], trackErr: null, playerState: null, url: location.href };
        try {
            const p = document.getElementById('movie_player');
            state.hasPlayer = !!p;
            if (p && typeof p.loadVideoById === 'function') {
                state.ready = true;
                try { state.playerState = (typeof p.getPlayerState === 'function') ? p.getPlayerState() : null; }
                catch (e) { state.playerState = 'threw'; }
                try {
                    const r = (typeof p.getPlayerResponse === 'function') ? p.getPlayerResponse() : null;
                    const list = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                    if (Array.isArray(list)) {
                        state.trackCount = list.length;
                        state.tracks = list.map((t) => `${t.languageCode}${t.kind ? '/' + t.kind : ''}`);
                        state.hasCaptions = list.length > 0;
                    }
                } catch (e) { state.trackErr = e.message; }
            }
        } catch (e) { state.trackErr = e.message; }
        window.postMessage({ type: 'YTSUB_PLAYER_READY', requestId, state }, '*');
    }

    // Player driver for coercion (same world constraint): load the video and
    // arm captions once the tracklist exists, reporting status back.
    // NOTE (2026-09-20): getOption('captions','tracklist') stays empty in
    // headless even when getPlayerResponse carries tracks (probe: seed sees
    // en/asr via probe while drive sees zero via getOption). So the track
    // source of truth is getPlayerResponse, and arming uses setOption +
    // toggle unconditionally instead of waiting on getOption.
    function drivePlayerCoercion(payload) {
        const { videoId, requestId, wantLang } = payload;
        const fail = (detail) => window.postMessage({ type: 'COERCE_PLAYER_FAILED', requestId, videoId, detail }, '*');
        const done = (detail) => window.postMessage({ type: 'COERCE_PLAYER_COMPLETE', requestId, videoId, detail }, '*');
        const respTracks = () => {
            try {
                const r = player?.getPlayerResponse?.();
                return r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            } catch (e) { return []; }
        };
        try { document.querySelectorAll('video, audio').forEach((el) => { el.muted = true; el.volume = 0; }); } catch (e) {}
        const player = document.getElementById('movie_player');
        if (!player || typeof player.loadVideoById !== 'function') {
            fail('no usable player');
            return;
        }
        let needLoad = true;
        try {
            const cur = player.getPlayerResponse?.();
            if (cur?.videoDetails?.videoId === videoId && respTracks().length > 0) needLoad = false;
        } catch (e) {}
        const armCaptions = () => {
            // Track source of truth is getPlayerResponse (attested server
            // payload), not getOption (UI state, empty in headless). Poll the
            // response, then arm unconditionally: loadModule + setOption +
            // toggle. The player's own timedtext request is what we capture.
            let trackTries = 0;
            const trackTimer = setInterval(() => {
                trackTries++;
                const tracks = respTracks();
                if (tracks.length > 0 || trackTries > 25) {
                    clearInterval(trackTimer);
                    window.postMessage({ type: 'COERCE_TRACKLIST', requestId, videoId,
                        tracks: tracks.map((t) => ({ languageCode: t.languageCode, kind: t.kind || null })) }, '*');
                    let pick = null;
                    if (wantLang) pick = tracks.find((t) => t.languageCode === wantLang) || null;
                    if (!pick) pick = tracks.find((t) => t.kind === 'asr') || tracks[0];
                    try {
                        if (typeof player.loadModule === 'function') {
                            try { player.loadModule('captions'); } catch (e) {}
                            try { player.loadModule('cc'); } catch (e) {}
                        }
                        if (pick && typeof player.setOption === 'function') {
                            try { player.setOption('captions', 'track', { languageCode: pick.languageCode }); } catch (e) {}
                            try { player.setOption('captions', 'track', { languageCode: pick.languageCode, kind: pick.kind || undefined }); } catch (e) {}
                        }
                        // Nudge the player into issuing the timedtext request:
                        // toggle off→on with a beat between, up to 3 cycles.
                        let cycle = 0;
                        const toggleTimer = setInterval(() => {
                            cycle++;
                            try {
                                if (typeof player.toggleSubtitles === 'function') {
                                    player.toggleSubtitles(false);
                                    setTimeout(() => { try { player.toggleSubtitles(true); } catch (e) {} }, 300);
                                }
                            } catch (e) {}
                            if (cycle >= 3) {
                                clearInterval(toggleTimer);
                                done('captions armed on ' + (pick ? pick.languageCode : 'default') +
                                    ` (respTracks=${tracks.length})`);
                            }
                        }, 800);
                    } catch (e) { fail('caption arm threw: ' + e.message); }
                }
            }, 200);
        };
        if (!needLoad) { armCaptions(); return; }
        try {
            player.loadVideoById({ videoId, muted: true });
        } catch (e) {
            try { player.loadVideoById(videoId); } catch (e2) { fail('loadVideoById threw'); return; }
        }
        let attempts = 0;
        const captionsTimer = setInterval(() => {
            attempts++;
            try {
                if (player.getPlayerState() === 1) {
                    clearInterval(captionsTimer);
                    armCaptions();
                } else if (attempts > 150) {
                    clearInterval(captionsTimer);
                    armCaptions();
                }
            } catch (e) {
                if (attempts > 150) { clearInterval(captionsTimer); fail('state poll threw'); }
            }
        }, 200);
    }

    // === MAIN WORLD FETCHER ===
    // Handler for fetch requests from content script.
    // NOTE: the content script (ISOLATED world) and this sniffer (MAIN world)
    // have SEPARATE window objects — window.postMessage from one world never
    // reaches the other's listener. So these three handlers also accept
    // same-type messages arriving via the page's own event flow: the content
    // script's postMessage lands in MAIN world (shared DOM event bus per
    // frame), where this listener runs. Verified 2026-09-20: YTSUB_PROBE_PLAYER
    // round-trips (WatchSeed logs real playerState), while direct
    // ISOLATED→MAIN data reads do not.
    window.addEventListener('message', async (event) => {
        // Do NOT filter by event.source: ISOLATED-world posts arrive with a
        // different source than MAIN-world self-posts, and filtering would
        // drop exactly the messages this bridge exists for. Type + requestId
        // matching is the trust boundary (same as the capture listener).
        const { type, url, requestId } = event.data || {};

        if (type === 'YTSUB_REQUEST_BACKFILL') {
            backfillTranscripts(requestId);
            return;
        }

        if (type === 'YTSUB_PROBE_PLAYER') {
            probePlayerReady(requestId);
            return;
        }

        if (type === 'YTSUB_DRIVE_PLAYER') {
            drivePlayerCoercion(event.data || {});
            return;
        }

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
