
import { translationManager } from './translation-manager.mjs';
import { BatchProcessor, generateErrorReport } from './batch-processor.mjs';

// Polyfills for library compatibility
if (typeof URL !== 'undefined' && !URL.createObjectURL) {
  URL.createObjectURL = function(blob) {
    return 'blob:fake://' + Math.random().toString(36).slice(2);
  };
  URL.revokeObjectURL = function() {};
}

import { zipSync, strToU8 } from 'fflate';

// More polyfills for library compatibility
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
    translationManager.clearCache(request.videoId);
    sendResponse({ success: true });
    return true;
  }

  // 4. Get Playlist Transcript (API-only tiers)
  if (request.type === 'GET_PLAYLIST_TRANSCRIPT') {
    handleGetPlaylistTranscript(request.videoId, request.options)
      .then(result => sendResponse({ success: true, data: result.transcript, logs: result.logs }))
      .catch(err => sendResponse({ success: false, error: err.message, logs: err.logs }));
    return true;
  }

  // 5. Batch Download Playlist Subtitles (fire-and-forget so popup can poll progress)
  if (request.type === 'BATCH_DOWNLOAD_PLAYLIST') {
    // Validate request
    if (!Array.isArray(request.videos) || request.videos.length === 0 || !request.playlistId) {
      globalThis.currentDownloadProgress = {
        playlistId: request.playlistId || '',
        status: 'error',
        error: 'Invalid request: videos and playlistId are required',
        total: 0,
        completed: 0,
        failed: 0
      };
      sendResponse({ success: false, error: 'Invalid request: videos and playlistId are required' });
      return true;
    }

    const downloadId = `playlist_${request.playlistId}_${Date.now()}`;
    // Initialize progress immediately so popup sees it on first poll
    globalThis.currentDownloadProgress = {
      playlistId: request.playlistId,
      status: 'running',
      completed: 0,
      total: request.videos.length,
      failed: 0,
      current: null
    };
    // Persist to storage for service worker restart recovery
    chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress }).catch(() => {});
    // Fire-and-forget: process in background, popup polls via GET_DOWNLOAD_PROGRESS
    handleBatchDownloadPlaylist(request.videos, request.options, request.playlistId, request.playlistTitle, downloadId)
      .catch(err => {
        console.error('[Background] Batch download failed:', err);
        globalThis.currentDownloadProgress = {
          playlistId: request.playlistId,
          status: 'error',
          error: err.message,
          total: request.videos.length,
          completed: globalThis.currentDownloadProgress?.completed || 0,
          failed: globalThis.currentDownloadProgress?.failed || 0
        };
        chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress }).catch(() => {});
      });
    // Return immediately so popup can start polling
    sendResponse({ success: true, data: { downloadId } });
    return true;
  }

  // 6. Get Download Progress
  if (request.type === 'GET_DOWNLOAD_PROGRESS') {
    // If globalThis is null (service worker restarted), restore from storage
    const restoreProgress = async () => {
      if (!globalThis.currentDownloadProgress) {
        const stored = await chrome.storage.local.get('currentDownloadProgress');
        if (stored.currentDownloadProgress) {
          globalThis.currentDownloadProgress = stored.currentDownloadProgress;
        }
      }
      return globalThis.currentDownloadProgress || null;
    };
    restoreProgress().then(data => {
      sendResponse({ success: true, data });
    }).catch(() => {
      sendResponse({ success: true, data: globalThis.currentDownloadProgress || null });
    });
    return true;
  }

  // 7. Clear Download Progress
  if (request.type === 'CLEAR_DOWNLOAD_PROGRESS') {
    globalThis.currentDownloadProgress = null;
    chrome.storage.local.remove('currentDownloadProgress').catch(() => {});
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

async function handleGetPlaylistTranscript(videoId, options = {}) {
  // Uses API-only tiers (0.5, 1, 1.5, 3 Legacy) - no active tab required
  const logs = [];
  const log = (msg) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const logMsg = `[${timestamp}] ${msg}`;
    console.log(logMsg);
    logs.push(logMsg);
  };
  
  log(`[Playlist] Starting fetch: ${videoId}, lang: ${options.lang}, translate: ${options.translate}`);
  
  try {
    const result = await translationManager.getTranscriptForPlaylist(videoId, {
      sourceLang: options.lang,
      targetLang: options.targetLang,
      translate: options.translate
    });

    if (result.logs) {
        logs.push(...result.logs);
    }

    log(`[Playlist] Success via ${result.source}!`);
    
    const transcript = result.result.map(item => ({
      start: Number(item.start),
      end: Number(item.start) + Number(item.duration || 0),
      text: item.text
    }));

    log(`[Playlist] Transcript length: ${transcript.length} segments`);
    
    return { transcript, logs };

  } catch (error) {
    if (error.logs) {
        logs.push(...error.logs);
    }
    log(`[Playlist] All API-only tiers failed: ${error.message}`);
    
    const err = new Error(error.message);
    err.logs = logs;
    throw err;
  }
}

async function handleBatchDownloadPlaylist(videos, options, playlistId, playlistTitle = '', downloadId) {
  // Progress is already initialized by the message handler

  let results = null;

  try {
    const processor = new BatchProcessor({
      concurrency: 2,
      delayMs: 300,
      onProgress: (progress) => {
        globalThis.currentDownloadProgress = {
          ...progress,
          playlistId,
          status: 'running'
        };
        chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress }).catch(() => {});
      },
      onVideoComplete: (result) => {
        console.log(`[Batch] Completed: ${result.videoId}`);
      },
      onVideoError: (error) => {
        console.log(`[Batch] Failed: ${error.videoId} - ${error.error}`);
      }
    });

    // Run batch processing
    results = await processor.process(videos, options);

    // Create ZIP with subtitles
    const zipData = {};
    const format = options.format || 'srt';
    const lang = options.translate ? options.targetLang : options.sourceLang;

    // Add subtitle files to ZIP
    for (const result of results.success) {
      const filename = generateSubtitleFilename(
        result.index,
        result.videoId,
        result.title,
        lang,
        format
      );

      // Convert transcript to selected format
      const content = formatTranscript(result.transcript.result, format);
      zipData[filename] = strToU8(content);
    }

    // Add error report if there are errors
    if (results.errors.length > 0) {
      const errorReport = generateErrorReport(results.errors);
      zipData['_errors.txt'] = strToU8(errorReport);
    }

    // Create ZIP blob
    const zipBlob = createZipInBackground(zipData);

    // Convert blob to base64 for storage with error handling
    const reader = new FileReader();
    const base64Data = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('FileReader failed to read blob'));
      reader.readAsDataURL(zipBlob);
    });

    await chrome.storage.local.set({
      [downloadId]: {
        data: base64Data,
        filename: generateZipFilename(playlistId, lang, playlistTitle),
        timestamp: Date.now()
      }
    });

    // Update progress to completed (popup will download with correct filename via DOM)
    globalThis.currentDownloadProgress = {
      playlistId,
      status: 'completed',
      completed: results.success.length + results.errors.length,
      total: videos.length,
      failed: results.errors.length,
      downloadId,
      autoDownloaded: false
    };
    chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress }).catch(() => {});

    return {
      downloadId,
      successCount: results.success.length,
      errorCount: results.errors.length,
      total: videos.length
    };

  } catch (err) {
    console.error('[Background] Batch download failed:', err);

    // Update progress to error state so popup can see it
    globalThis.currentDownloadProgress = {
      playlistId,
      status: 'error',
      completed: results?.success?.length || 0,
      total: videos.length,
      failed: results?.errors?.length || 0,
      error: err.message,
      downloadId
    };

    throw err;
  }
}

// Helper function to convert transcript to SRT
function toSRT(transcript) {
  if (!Array.isArray(transcript)) return '';

  return transcript.map((item, i) => {
    const start = formatTimeSRT(item.start);
    const end = formatTimeSRT(item.end || (item.start + (item.duration || 0)));
    return `${i + 1}\n${start} --> ${end}\n${item.text}\n`;
  }).join('\n');
}

function formatTimeSRT(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Helper function to convert transcript to VTT
function toVTT(transcript) {
  if (!Array.isArray(transcript)) return '';

  const lines = ['WEBVTT\n'];

  for (const item of transcript) {
    const start = formatTimeVTT(item.start);
    const end = formatTimeVTT(item.end || (item.start + (item.duration || 0)));
    lines.push(`${start} --> ${end}`);
    lines.push(item.text);
    lines.push('');
  }

  return lines.join('\n');
}

function formatTimeVTT(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Helper function to convert transcript to TXT
function toTXT(transcript) {
  if (!Array.isArray(transcript)) return '';

  return transcript.map(item => item.text).join('\n\n');
}

// Format dispatcher
function formatTranscript(transcript, format) {
  switch (format.toLowerCase()) {
    case 'vtt':
      return toVTT(transcript);
    case 'txt':
      return toTXT(transcript);
    case 'srt':
    default:
      return toSRT(transcript);
  }
}

// Helper to create ZIP in background (sync — no Workers needed in MV3 service worker)
function createZipInBackground(zipData) {
  const data = zipSync(zipData, { level: 6 });
  return new Blob([data], { type: 'application/zip' });
}

function generateSubtitleFilename(index, videoId, title, language, format) {
  const ext = format.toLowerCase();
  const paddedIndex = String(index).padStart(2, '0');
  const sanitizedTitle = sanitizeVideoTitle(title);
  return `${paddedIndex}_${sanitizedTitle}_${videoId}_${language}.${ext}`;
}

function sanitizeVideoTitle(title) {
  if (!title) return 'untitled';
  // Only strip filesystem-invalid characters (popup DOM download supports Cyrillic)
  return title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[#&%+@!^()\[\]{}]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50);
}

function generateZipFilename(playlistId, language, title = '') {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shortPlaylistId = playlistId.substring(0, 15);
  const sanitizedTitle = title
    ? sanitizeVideoTitle(title).substring(0, 30) + '_'
    : '';
  const filename = `playlist_${sanitizedTitle}${shortPlaylistId}_${language}_${timestamp}.zip`;
  console.log('[Background] generateZipFilename - title:', title, '→ sanitized:', sanitizedTitle, '→ filename:', filename);
  return filename;
}
