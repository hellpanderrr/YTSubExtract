
import { translationManager } from './translation-manager.mjs';

// Polyfills for library compatibility
if (typeof document === 'undefined') {
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    createElement: () => ({ style: {}, appendChild: () => {} }),
    cookie: '',
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    documentElement: { style: {} }
  };
}
if (typeof window === 'undefined') {
  globalThis.window = globalThis;
  if (!globalThis.window.document) {
    globalThis.window.document = globalThis.document;
  }
}
if (typeof localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {}
  };
}

// Message Handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. Get Video Metadata (Languages)
  if (request.type === 'GET_VIDEO_METADATA') {
    handleGetVideoMetadata(request.videoId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Async response
  }

  // 2. Get Transcript (with optional translation)
  if (request.type === 'GET_TRANSCRIPT') {
    handleGetTranscript(request.videoId, request.options)
      .then(result => sendResponse({ success: true, data: result.transcript, logs: result.logs }))
      .catch(err => sendResponse({ success: false, error: err.message, logs: err.logs }));
    return true; // Async response
  }

  // 3. Clear Cache (Optional)
  if (request.type === 'CLEAR_CACHE') {
    translationManager.clearCache();
    sendResponse({ success: true });
    return true;
  }
});

async function handleGetVideoMetadata(videoId) {
  // Use TranslationManager which handles Tier 1/2/3 fallback and caching
  try {
    return await translationManager.getMetadata(videoId);
  } catch (error) {
    throw new Error(`Failed to get metadata: ${error.message}`);
  }
}

async function handleGetTranscript(videoId, options = {}) {
  // options = { lang, translate, targetLang }
  const logs = [];
  const log = (msg) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const logMsg = `[${timestamp}] ${msg}`;
    console.log(logMsg);
    logs.push(logMsg);
  };
  
  log(`Starting fetch: ${videoId}, lang: ${options.lang}, translate: ${options.translate}, target: ${options.targetLang}`);
  
  try {
    const result = await translationManager.extractWithTranslation(videoId, {
      sourceLang: options.lang,
      targetLang: options.targetLang,
      translate: options.translate,
      preferTier: 1
    });

    if (result.logs) {
        logs.push(...result.logs);
    }

    log(`Success via ${result.source}!`);
    
    // Check if result.result is valid array
    if (!Array.isArray(result.result)) {
        throw new Error(`Invalid result format from ${result.source}: not an array`);
    }

    const transcript = result.result.map(item => ({
      start: Number(item.start),
      end: Number(item.start) + Number(item.duration || item.dur || 0),
      text: item.text
    }));

    log(`Transcript length: ${transcript.length} segments`);
    
    if (transcript.length === 0) {
        log('Warning: Transcript is empty!');
    }

    return { transcript, logs };

  } catch (error) {
    if (error.logs) {
        logs.push(...error.logs);
    }
    log(`All extraction methods failed: ${error.message}`);
    
    const err = new Error(error.message);
    err.logs = logs;
    throw err;
  }
}
