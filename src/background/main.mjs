
import { translationManager } from './translation-manager.mjs';
import { BatchProcessor, generateErrorReport } from './batch-processor.mjs';
import { fetchPlaylistVideosAPI } from '../utils/playlist-extractor.js';

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

// Global guards to prevent race conditions
if (typeof globalThis.isBatchProcessing === 'undefined') {
  globalThis.isBatchProcessing = false;
}

// Memoization for GET_DOWNLOAD_PROGRESS to prevent redundant storage reads
if (typeof globalThis.restoreProgressPromise === 'undefined') {
  globalThis.restoreProgressPromise = null;
}

// Message Handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 1. Get Video Metadata (Languages)
    if (request.type === 'GET_VIDEO_METADATA') {
        // Atomic update of currentDownloadProgress to avoid overwriting on SW start
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
    // ATOMIC GUARD: Prevent concurrent batch processing
    if (globalThis.isBatchProcessing) {
      console.warn('[Main] Batch download already in progress, rejecting concurrent request');
      sendResponse({ success: false, error: 'Batch download already in progress' });
      return true;
    }

    // Validate request
    if (!Array.isArray(request.videos) || request.videos.length === 0 || !request.playlistId) {
      // Use atomic update even for validation errors (fire-and-forget)
      atomicProgressUpdate({
        playlistId: request.playlistId || '',
        status: 'error',
        error: 'Invalid request: videos and playlistId are required',
        total: 0,
        completed: 0,
        failed: 0
      }, { force: true }).catch(() => {});
      sendResponse({ success: false, error: 'Invalid request: videos and playlistId are required' });
      return true;
    }

    // Set guard atomically before any async operations
    globalThis.isBatchProcessing = true;

    const downloadId = `playlist_${request.playlistId}_${Date.now()}`;
    // Initialize progress atomically so popup sees it on first poll (fire-and-forget)
    atomicProgressUpdate({
      playlistId: request.playlistId,
      status: 'running',
      completed: 0,
      total: request.videos.length,
      failed: 0,
      current: null,
      downloadId
    }, { force: true }).catch(() => {});
    // Fire-and-forget: process in background, popup polls via GET_DOWNLOAD_PROGRESS
    handleBatchDownloadPlaylist(request.videos, request.options, request.playlistId, request.playlistTitle, downloadId)
      .catch((err) => {
        console.error('[Background] Batch download failed:', err);
        // Atomic error state update (fire-and-forget)
        atomicProgressUpdate({
          playlistId: request.playlistId,
          status: 'error',
          error: err.message,
          total: request.videos.length
        }, { force: true }).catch(() => {});
      })
      .finally(() => {
        // ALWAYS reset the guard when batch completes (success, error, or stopped)
        globalThis.isBatchProcessing = false;
        console.log('[Main] Batch processing guard reset');
      });
    // Return immediately so popup can start polling
    sendResponse({ success: true, data: { downloadId } });
    return true;
  }

  // 6. Get Download Progress
  if (request.type === 'GET_DOWNLOAD_PROGRESS') {
    // MEMOIZED: Prevent concurrent storage reads from causing race conditions
    const restoreProgress = async () => {
      if (!globalThis.currentDownloadProgress) {
        // Check if there's already a restore in progress
        if (globalThis.restoreProgressPromise) {
          console.log('[Main] Reusing in-progress restore operation');
          return globalThis.restoreProgressPromise;
        }

        // Create the restore promise
        globalThis.restoreProgressPromise = (async () => {
          const stored = await chrome.storage.local.get('currentDownloadProgress');
          if (stored.currentDownloadProgress) {
            globalThis.currentDownloadProgress = stored.currentDownloadProgress;
          }
          return globalThis.currentDownloadProgress || null;
        })();

        // Clear the memoized promise when done (success or error)
        globalThis.restoreProgressPromise.finally(() => {
          globalThis.restoreProgressPromise = null;
        });

        return globalThis.restoreProgressPromise;
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

  // 8. Get Playlist Videos (Tier 0.5 DOM extraction first, then API fallback)
  if (request.type === 'GET_PLAYLIST_VIDEOS') {
    (async () => {
      try {
        // Try Tier 0.5 first (DOM extraction for private playlists)
        console.log(`[Main] Trying Tier 0.5 for playlist: ${request.playlistId}`);
        const tier05Result = await translationManager._getPlaylistVideosTier0_5(request.playlistId);

        if (tier05Result && tier05Result.videos && tier05Result.videos.length > 0) {
          console.log(`[Main] Tier 0.5 success: ${tier05Result.videos.length} videos`);
          sendResponse({
            success: true,
            videos: tier05Result.videos.map((v, i) => ({ ...v, index: i + 1 })),
            title: tier05Result.title,
            source: 'tier0.5'
          });
          return;
        }

        // Fall back to API extraction
        console.log(`[Main] Tier 0.5 failed or empty, falling back to API`);
        const apiResult = await fetchPlaylistVideosAPI(request.playlistId, request.maxResults);

        sendResponse({
          success: true,
          videos: apiResult.videos,
          title: apiResult.title,
          source: 'api'
        });
      } catch (err) {
        console.error('[Main] Failed to get playlist videos:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
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
      concurrency: 3,
      delayMs: 300,
      onProgress: async (progress) => {
        // Atomic state update: read, merge, write
        try {
          const stored = await chrome.storage.local.get('currentDownloadProgress');
          const current = stored.currentDownloadProgress || globalThis.currentDownloadProgress || {};
          
          // Don't overwrite completed or error status with running from a potentially stale processor
          if (current.status === 'completed' || current.status === 'error') {
             // If we already finished in storage, just keep it
             globalThis.currentDownloadProgress = current;
             return;
          }

          globalThis.currentDownloadProgress = {
            ...progress,
            playlistId,
            status: 'running',
            downloadId: downloadId
          };
          await chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress });
        } catch (e) {
          console.error('[Background] Progress update failed:', e);
        }
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

    // Create ZIP blob (async to avoid blocking service worker)
    const zipBlob = await createZipInBackground(zipData);

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
    try {
      const stored = await chrome.storage.local.get('currentDownloadProgress');
      const current = stored.currentDownloadProgress || {};
      
      globalThis.currentDownloadProgress = {
        ...current,
        playlistId,
        status: 'completed',
        completed: results.success.length + results.errors.length,
        total: videos.length,
        failed: results.errors.length,
        downloadId,
        autoDownloaded: false
      };
      await chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress });
    } catch (e) {
      console.error('[Background] Final progress update failed:', e);
    }

    return {
      downloadId,
      successCount: results.success.length,
      errorCount: results.errors.length,
      total: videos.length
    };

  } catch (err) {
    console.error('[Background] Batch download failed:', err);

    // Update progress to error state so popup can see it
    try {
      const stored = await chrome.storage.local.get('currentDownloadProgress');
      const current = stored.currentDownloadProgress || {};

      globalThis.currentDownloadProgress = {
        ...current,
        playlistId,
        status: 'error',
        completed: results?.success?.length || current.completed || 0,
        total: videos.length,
        failed: results?.errors?.length || current.failed || 0,
        error: err.message,
        downloadId
      };
      await chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress });
    } catch (e) {
      console.error('[Background] Error state update failed:', e);
    }

    throw err;
  }
}

/**
 * Atomic progress update helper
 * Reads current state from storage, merges with updates, writes back.
 * Prevents stale state overwrites from concurrent updates or SW restarts.
 */
async function atomicProgressUpdate(updates, options = {}) {
  try {
    const stored = await chrome.storage.local.get('currentDownloadProgress');
    const current = stored.currentDownloadProgress || globalThis.currentDownloadProgress || {};

    // By default, don't overwrite completed/error states with running updates
    if (!options.force && (current.status === 'completed' || current.status === 'error')) {
      globalThis.currentDownloadProgress = current;
      return current;
    }

    const merged = {
      ...current,
      ...updates,
      // Preserve critical fields if not explicitly provided
      playlistId: updates.playlistId ?? current.playlistId,
      downloadId: updates.downloadId ?? current.downloadId
    };

    globalThis.currentDownloadProgress = merged;
    await chrome.storage.local.set({ currentDownloadProgress: merged });
    return merged;
  } catch (e) {
    console.error('[Main] Atomic progress update failed:', e);
    // Fallback: just update globalThis
    globalThis.currentDownloadProgress = { ...globalThis.currentDownloadProgress, ...updates };
    return globalThis.currentDownloadProgress;
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

// Helper to create ZIP synchronously (Web Workers not supported in Service Worker)
function createZipInBackground(zipData) {
  try {
    const data = zipSync(zipData, { level: 6 });
    return Promise.resolve(new Blob([data], { type: 'application/zip' }));
  } catch (err) {
    return Promise.reject(err);
  }
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
