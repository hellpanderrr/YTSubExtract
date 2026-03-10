// === NETWORK SNIFFER ===
// Injected into MAIN world to intercept fetch/XHR
// Captures URLs with timedtext (subtitles)
// Runs in YouTube page context

(function() {
    'use strict';
    
    // Save original functions immediately (before other extensions)
    const _fetch = window.fetch;
    const _xhrOpen = XMLHttpRequest.prototype.open;
    
    // Check if URL is a subtitle URL
    function isTimedTextUrl(url) {
        return typeof url === 'string' && url.includes('timedtext');
    }
    
    // Extract videoId and lang from URL
    function parseTimedTextUrl(url) {
        try {
            // URL can be relative or absolute
            const urlObj = new URL(url, 'https://www.youtube.com');
            const videoId = urlObj.searchParams.get('v');
            const lang = urlObj.searchParams.get('lang') || urlObj.searchParams.get('tlang');
            const hl = urlObj.searchParams.get('hl');
            const caps = urlObj.searchParams.get('caps');
            
            // Debug logging
            console.log(`[YTSub Sniffer] Parsing URL: langParam=${lang}, hlParam=${hl}, caps=${caps}`);
            
            return { videoId, lang, url };
        } catch (e) {
            return null;
        }
    }
    
    // Save captured URL
    function captureUrl(url) {
        const parsed = parseTimedTextUrl(url);
        if (!parsed || !parsed.videoId) return;
        
        const { videoId, lang } = parsed;
        
        // Send to content script via postMessage
        window.postMessage({
            type: 'YTSUB_CAPTURED_URL',
            videoId,
            lang: lang || 'unknown',
            url,
            timestamp: Date.now()
        }, '*');
        
        // Log full URL for debugging (truncated for readability)
        console.log(`[YTSub Sniffer] Captured: video=${videoId}, lang=${lang || 'unknown'}, url=${url.substring(0, 150)}...`);
    }
    
    // Intercept fetch
    window.fetch = async function(...args) {
        const url = args[0]?.url || args[0];
        
        if (isTimedTextUrl(url)) {
            captureUrl(url);
        }
        
        return _fetch.apply(this, args);
    };
    
    // Intercept XMLHttpRequest.open
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (isTimedTextUrl(url)) {
            captureUrl(url);
        }
        
        return _xhrOpen.call(this, method, url, ...rest);
    };
    
    // === MAIN WORLD FETCHER ===
    // Handler for fetch requests from content script
    // Uses original _fetch to avoid recursion
    window.addEventListener('message', async (event) => {
        // Only accept messages from our content script
        if (event.source !== window) return;
        
        const { type, url, requestId } = event.data || {};
        
        if (type === 'REQUEST_MAIN_WORLD_FETCH') {
            console.log(`[YTSub Sniffer] Main World Fetch request: ${url.substring(0, 100)}...`);
            
            try {
                // CRITICAL: Use _fetch (original), NOT window.fetch
                // to avoid recursion through our interceptor
                const response = await _fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/xml, text/xml, */*'
                    }
                });
                
                const text = await response.text();
                
                // Send result back to content script
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
                // Send error back to content script
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
    
    console.log('[YTSub Sniffer] Initialized in MAIN world (with Main World Fetcher)');
})();
