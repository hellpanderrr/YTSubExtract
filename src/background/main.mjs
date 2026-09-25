
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
// Live BatchProcessor instance for the active batch (Stop button target).
if (typeof globalThis.activeBatchProcessor === 'undefined') {
  globalThis.activeBatchProcessor = null;
}
// True from "processor.process resolved" until the terminal status write.
// STOP refuses to act during finalization: writing 'stopping' after the
// terminal status would soft-lock the popup (nothing writes progress again).
if (typeof globalThis.batchFinalizing === 'undefined') {
  globalThis.batchFinalizing = false;
}

// Memoization for GET_DOWNLOAD_PROGRESS to prevent redundant storage reads
if (typeof globalThis.restoreProgressPromise === 'undefined') {
  globalThis.restoreProgressPromise = null;
}

// MAIN-world player probe/drive state shared with the content script.
// chrome.scripting.executeScript({world:'MAIN'}) is the only channel that
// provably reaches page JS (ISOLATED-world script injection does not execute
// on youtube.com; ISOLATED→MAIN postMessage does not cross worlds — proven
// 2026-09-20). sender.tab.id scopes the injection to the requesting tab.
const MAIN_PROBE_FUNC = () => {
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
  return state;
};

const MAIN_DRIVE_FUNC = (videoId, wantLang) => {
  const fail = (detail) => window.postMessage({ type: 'COERCE_PLAYER_FAILED', requestId: 'scripting', videoId, detail }, '*');
  const done = (detail) => window.postMessage({ type: 'COERCE_PLAYER_COMPLETE', requestId: 'scripting', videoId, detail }, '*');
  try { document.querySelectorAll('video, audio').forEach((el) => { el.muted = true; el.volume = 0; }); } catch (e) {}
  const player = document.getElementById('movie_player');
  if (!player || typeof player.loadVideoById !== 'function') {
    // Status goes through the MAIN-world sniffer's fetch/XHR hook logs; the
    // ISOLATED listener can't see this postMessage, so throw to surface it.
    throw new Error('no usable player in MAIN world');
  }
  const respTracks = () => {
    try {
      const r = player.getPlayerResponse?.();
      return r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch (e) { return []; }
  };
  let needLoad = true;
  try {
    const cur = player.getPlayerResponse?.();
    if (cur?.videoDetails?.videoId === videoId && respTracks().length > 0) needLoad = false;
  } catch (e) {}
  const armCaptions = () => {
    // Settled-fast (mirrors sniffer drivePlayerCoercion): a confirmed-this-
    // video response with 0 tracks on 2 consecutive polls means nothing to
    // arm against — report immediately instead of the full 25-try budget.
    const settledVideoId = () => {
      try { return player?.getPlayerResponse?.()?.videoDetails?.videoId || null; }
      catch (e) { return null; }
    };
    let trackTries = 0;
    let settledZeroStreak = 0;
    const trackTimer = setInterval(() => {
      trackTries++;
      const tracks = respTracks();
      if (tracks.length === 0 && settledVideoId() === videoId) {
        settledZeroStreak++;
      } else {
        settledZeroStreak = 0;
      }
      if (tracks.length > 0 || trackTries > 25 || settledZeroStreak >= 2) {
        clearInterval(trackTimer);
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
  if (!needLoad) { armCaptions(); return 'already on video'; }
  try {
    player.loadVideoById({ videoId, muted: true });
  } catch (e) {
    try { player.loadVideoById(videoId); } catch (e2) { throw new Error('loadVideoById threw'); }
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
  return 'drive dispatched';
};

// Message Handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // MAIN-world probe/drive via chrome.scripting (fallback when the sniffer
  // postMessage bridge is unreachable). sender.tab scopes to the tab.
  if (request.type === 'PROBE_PLAYER_MAIN') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) throw new Error('no sender tab');
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: MAIN_PROBE_FUNC,
        });
        sendResponse({ success: true, state: res?.result || { ready: false, probeErr: 'empty result' } });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (request.type === 'DRIVE_PLAYER_MAIN') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) throw new Error('no sender tab');
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: MAIN_DRIVE_FUNC,
          args: [request.videoId, request.wantLang || null],
        });
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
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
    // Fresh batch: clear any stale Stop request / driver-tab pin from a previous run
    translationManager._batchCancelled = false;
    translationManager._batchTabId = null;
    translationManager._originalTabUrl = null;
    globalThis.batchFinalizing = false;

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
        // Atomic error state update (fire-and-forget) — unless the failure
        // followed an accepted Stop (restore already cleared the flag, so
        // trust the marker handleBatchDownloadPlaylist attached).
        atomicProgressUpdate({
          playlistId: request.playlistId,
          status: err.wasStopped ? 'stopped' : 'error',
          error: err.message,
          total: request.videos.length
        }, { force: true }).catch(() => {});
      })
      .finally(() => {
        // ALWAYS reset the guard when batch completes (success, error, or stopped)
        globalThis.isBatchProcessing = false;
        globalThis.activeBatchProcessor = null;
        globalThis.batchFinalizing = false;
        console.log('[Main] Batch processing guard reset');
      });
    // Return immediately so popup can start polling
    sendResponse({ success: true, data: { downloadId } });
    return true;
  }

  // 5b. Stop the active batch download (Stop button)
  if (request.type === 'STOP_BATCH_DOWNLOAD') {
    if (!globalThis.isBatchProcessing) {
      sendResponse({ success: false, error: 'No batch running' });
      return true;
    }
    // Finalizing (ZIP + restore) — the terminal status write is imminent or
    // done. Writing 'stopping' now would clobber 'stopped'/'completed' and
    // nothing would ever write progress again (permanently stuck popup).
    if (globalThis.batchFinalizing) {
      sendResponse({ success: false, error: 'Batch already finished' });
      return true;
    }
    // Cooperative cancel: queued videos skip, page-leg tiers bail at their
    // next checkpoint, 2C aborts its poll within one tick.
    translationManager._batchCancelled = true;
    if (globalThis.activeBatchProcessor) globalThis.activeBatchProcessor.stop();
    atomicProgressUpdate({ status: 'stopping' }, { force: true }).catch(() => {});
    console.log('[Main] Stop requested for active batch');
    sendResponse({ success: true });
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
        console.error(`[Main] API failed: ${err.message}`);

        // Final fallback: credentialed playlist page fetch via content script
        // This handles private playlists (e.g. LL) where all unauthenticated
        // API clients return "does not exist"
        try {
          console.log(`[Main] Trying credentialed fetch for playlist: ${request.playlistId}`);
          const fetchResult = await translationManager._fetchPlaylistPageAuth(request.playlistId);

          if (fetchResult && fetchResult.videos && fetchResult.videos.length > 0) {
            console.log(`[Main] Credentialed fetch success: ${fetchResult.videos.length} videos`);
            sendResponse({
              success: true,
              videos: fetchResult.videos.map((v, i) => ({ ...v, index: i + 1 })),
              title: fetchResult.title || '',
              source: 'tier0.5-auth'
            });
            return;
          }
        } catch (authErr) {
          console.error('[Main] Credentialed fetch also failed:', authErr.message);
        }

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
          
          // Don't overwrite terminal/stop states from a potentially stale processor
          if (current.status === 'completed' || current.status === 'error' ||
              current.status === 'stopping' || current.status === 'stopped') {
             // If we already finished (or are stopping) in storage, just keep it
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
    globalThis.activeBatchProcessor = processor;

    // Seed the tab ONCE to a /watch page so Tier 1.7 player coercion has a
    // real movie_player to drive via loadVideoById (one navigation per
    // batch; later videos switch in-page). Keeps playlist context (&list=).
    // restoreOriginalTab (end of batch) returns the user to the list page.
    if (videos.length > 0) {
      await translationManager.seedWatchPage(videos[0].videoId, playlistId).catch(() => {});
    }
    results = await processor.process(videos, options);
    // Phase flip: from here only the terminal write may touch progress status.
    globalThis.batchFinalizing = true;
    const wasStopped = translationManager._batchCancelled;

    // Create ZIP with subtitles — skipped entirely when the user stopped the
    // batch with zero successes (nothing to deliver). A partial batch with
    // successes still ships a ZIP, saved silently (no Save-As dialog) since
    // the user just asked everything to stop.
    const stopWithoutResults = wasStopped && results.success.length === 0;
    let swDownloaded = false;
    if (stopWithoutResults) {
      console.log('[Background] Batch stopped with no successful transcripts — skipping ZIP');
    } else {
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

    // Create ZIP data (sync, returns Uint8Array)
    let zipUint8;
    try {
      zipUint8 = zipSync(zipData, { level: 6 });
    } catch (err) {
      throw new Error(`ZIP creation failed: ${err.message}`);
    }

    // Convert Uint8Array → base64 data URL (avoids FileReader/Blob URL in SW)
    const filename = generateZipFilename(playlistId, lang, playlistTitle);
    let binary = '';
    for (let i = 0; i < zipUint8.length; i++) {
      binary += String.fromCharCode(zipUint8[i]);
    }
    const dataUrl = 'data:application/zip;base64,' + btoa(binary);

    try {
      await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: !wasStopped // silent partial download when stopping
      });
      // Mark that SW already triggered the download — popup just needs to show success
      swDownloaded = true;
    } catch (e) {
      console.error('[Background] chrome.downloads.download failed:', e);
      // Fallback: store in storage for popup-based download
      try {
        await chrome.storage.local.set({
          [downloadId]: {
            data: dataUrl.split(',')[1],
            filename: filename,
            timestamp: Date.now()
          }
        });
      } catch (storeErr) {
        console.error('[Background] Storage fallback also failed:', storeErr);
      }
    }
    } // end !stopWithoutResults

    // Update progress to completed/stopped
    try {
      const stored = await chrome.storage.local.get('currentDownloadProgress');
      const current = stored.currentDownloadProgress || {};

      globalThis.currentDownloadProgress = {
        ...current,
        playlistId,
        status: wasStopped ? 'stopped' : 'completed',
        completed: results.success.length + results.errors.length,
        total: videos.length,
        failed: results.errors.length,
        downloadId,
        autoDownloaded: false,
        swDownloaded,
        ...(wasStopped ? { stoppedSaved: swDownloaded } : {})
      };
      await chrome.storage.local.set({ currentDownloadProgress: globalThis.currentDownloadProgress });
    } catch (e) {
      console.error('[Background] Final progress update failed:', e);
    }

    // Restore tab to original URL after batch completes
    await translationManager.restoreOriginalTab();

    return {
      downloadId,
      successCount: results.success.length,
      errorCount: results.errors.length,
      total: videos.length
    };

  } catch (err) {
    // If this failure happened after an accepted Stop, the user's terminal
    // state is 'stopped', not 'error' — capture the flag before restore
    // clears it and mark the error for the outer catch.
    const stoppedAlready = translationManager._batchCancelled;
    err.wasStopped = stoppedAlready;
    console.error('[Background] Batch download failed:', err);

    // Update progress to error/stopped state so popup can see it
    try {
      const stored = await chrome.storage.local.get('currentDownloadProgress');
      const current = stored.currentDownloadProgress || {};

      globalThis.currentDownloadProgress = {
        ...current,
        playlistId,
        status: stoppedAlready ? 'stopped' : 'error',
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

    // Restore tab to original URL even on error
    await translationManager.restoreOriginalTab();

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
