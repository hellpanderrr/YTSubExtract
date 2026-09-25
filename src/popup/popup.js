import { toSRT, toVTT, toTXT } from '../utils/subtitle-formats.js';
import { SUPPORTED_LANGUAGES } from '../utils/languages.js';
import { isPlaylistUrl, extractPlaylistId, fetchPlaylistVideos } from '../utils/playlist-extractor.js';
import { extractVideoId, isYouTubeHost } from '../utils/video-url.js';

const statusEl = document.getElementById('status');
const statusIcon = document.getElementById('status-icon');
const btnReset = document.getElementById('reset-btn');
const langSelect = document.getElementById('lang-select');
const btnSrt = document.getElementById('btn-srt');
const btnVtt = document.getElementById('btn-vtt');
const btnTxt = document.getElementById('btn-txt');
const logsContainer = document.getElementById('logs-container');
const logsToggle = document.getElementById('logs-toggle');
const logsEl = document.getElementById('logs');
const btnCopyLogs = document.getElementById('copy-logs');
const translateCheck = document.getElementById('translate-check');
const translateLang = document.getElementById('translate-lang');
const translationOptions = document.getElementById('translation-options');

let currentVideoId = null;
let currentVideoTitle = null;
let currentTranscript = null;
let currentPlaylistId = null;
let currentPlaylistTitle = '';
let currentPlaylistVideos = [];
let isPlaylistMode = false;

// Playlist UI elements
const playlistModeEl = document.getElementById('playlist-mode');
const playlistCountEl = document.getElementById('playlist-count');
const selectAllCheck = document.getElementById('select-all');
const selectedCountEl = document.getElementById('selected-count');
const playlistVideosEl = document.getElementById('playlist-videos');
const btnDownloadZip = document.getElementById('btn-download-zip');
const playlistProgressEl = document.getElementById('playlist-progress');
const progressFillEl = document.getElementById('progress-fill');
const progressTextEl = document.getElementById('progress-text');
const btnStopDownload = document.getElementById('btn-stop-download');
const controlsEl = document.querySelector('.controls');

// Playlist language controls
const playlistLangSelect = document.getElementById('playlist-lang-select');
const playlistFormatSelect = document.getElementById('playlist-format-select');
const playlistTranslateCheck = document.getElementById('playlist-translate-check');
const playlistTranslateLang = document.getElementById('playlist-translate-lang');
const playlistTranslationOptions = document.getElementById('playlist-translation-options');

function setStatus(msg, type = 'info', loading = false) {
  statusEl.textContent = msg;
  statusEl.title = msg; // Tooltip for long text
  statusEl.style.color = type === 'error' ? '#d32f2f' : (type === 'success' ? '#2e7d32' : '#666');

  // CSS keys visibility off `.spinner.active` (`.spinner` itself is
  // display:none); `hidden` is belt-and-braces. Toggling only `hidden` — as
  // this did until 2026-09-25 — left the spinner invisible in EVERY loading
  // state (playlist load, "Fetching languages…", batch start/progress).
  statusIcon.classList.toggle('active', loading);
  statusIcon.classList.toggle('hidden', !loading);
}

function showLogs(logs) {
  if (logs && logs.length > 0) {
    logsContainer.classList.remove('hidden');
    logsEl.value = logs.join('\n');
    // Scroll to bottom
    logsEl.scrollTop = logsEl.scrollHeight;
  }
}

/**
 * Append a log entry for playlist operations
 * @param {string} message - Log message to append
 */
function appendPlaylistLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logLine = `[${timestamp}] ${message}`;

  logsContainer.classList.remove('hidden');

  // Append to existing logs or start fresh
  const currentLogs = logsEl.value;
  if (currentLogs) {
    logsEl.value = currentLogs + '\n' + logLine;
  } else {
    logsEl.value = logLine;
  }

  // Scroll to bottom
  logsEl.scrollTop = logsEl.scrollHeight;
}

function enableControls(enabled) {
  langSelect.disabled = !enabled;
  btnSrt.disabled = !enabled;
  btnVtt.disabled = !enabled;
  btnTxt.disabled = !enabled;
  translateCheck.disabled = !enabled;
  
  updateTranslationState();
}

function updateTranslationState() {
  const enabled = !translateCheck.disabled && translateCheck.checked;
  translateLang.disabled = !enabled;
  
  if (translateCheck.checked) {
    translationOptions.classList.add('visible');
  } else {
    translationOptions.classList.remove('visible');
  }
}

/**
 * Last-resort video-ID detection for YouTube URLs that carry no ID in the URL
 * itself (e.g. /@channel/live). Reads the player from the MAIN world — the
 * ISOLATED popup cannot touch page-JS expandos like getPlayerResponse.
 * Returns null on any failure (no player, non-injectable tab, etc).
 */
async function probePageVideoId(tabId) {
  if (tabId == null || !chrome.scripting) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          const p = document.getElementById('movie_player');
          const r = (p && typeof p.getPlayerResponse === 'function') ? p.getPlayerResponse() : null;
          const id = r?.videoDetails?.videoId;
          if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
        } catch (e) { /* fall through */ }
        const m = location.pathname.match(/^\/(?:live|shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
      },
    });
    return res?.result || null;
  } catch (e) {
    console.log('[Popup] probePageVideoId failed:', e.message);
    return null;
  }
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      setStatus('No active tab', 'error');
      return;
    }

    const url = new URL(tab.url);
    
    // Check for playlist mode
    if (isPlaylistUrl(tab.url)) {
      currentPlaylistId = extractPlaylistId(tab.url);
      if (!currentPlaylistId) {
        setStatus('Failed to extract playlist ID', 'error');
        return;
      }
      isPlaylistMode = true;

      btnReset.style.display = 'flex';
      setStatus(`Playlist found: ${currentPlaylistId}`);

      // Hide single video controls, show playlist UI
      if (controlsEl) controlsEl.classList.add('hidden');
      playlistModeEl.classList.remove('hidden');

      const videos = await loadPlaylistVideos(currentPlaylistId);
      if (videos) {
        await finalizePlaylistLoad(videos);
      }
      return;
    }

    // Single video mode — accepts /watch?v=, /live/ID, /shorts/ID, /embed/ID
    // and youtu.be/ID. If the URL carries no ID (e.g. /@channel/live), fall
    // back to a MAIN-world probe of the player before giving up.
    if (isYouTubeHost(url.hostname)) {
      let videoId = extractVideoId(tab.url);
      if (!videoId) {
        videoId = await probePageVideoId(tab.id);
      }

      if (videoId) {
        currentVideoId = videoId;
        isPlaylistMode = false;

        // Don't trust tab.title immediately as it might be stale from previous video
        currentVideoTitle = 'Loading title...';

        // Show reset button
        btnReset.style.display = 'flex';
        setStatus(`Video found: ${currentVideoId}`);

        // Show single video controls, hide playlist UI
        if (controlsEl) controlsEl.classList.remove('hidden');
        playlistModeEl.classList.add('hidden');

        fetchLanguages(currentVideoId);
        return;
      }
    }

    btnReset.style.display = 'none';
    setStatus('Not a YouTube video or playlist page', 'error');
  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
  }
}

async function loadPlaylistVideos(playlistId) {
  setStatus('Loading playlist videos...', 'info', true);
  btnDownloadZip.disabled = true;
  playlistCountEl.textContent = 'Loading…';
  playlistVideosEl.innerHTML =
    '<div style="padding: 20px; text-align: center; color: #666;">Loading videos…</div>';

  try {
    console.log('[Popup] Fetching playlist:', playlistId);
    const result = await fetchPlaylistVideos(playlistId);
    console.log('[Popup] Got result:', result);

    const videos = result.videos || result; // Handle both old and new format
    currentPlaylistTitle = result.title || '';
    currentPlaylistVideos = videos.map((v) => ({ ...v, selected: true }));

    playlistCountEl.textContent = `${videos.length} videos`;

    renderPlaylistVideos();
    updateSelectedCount();
    // Keep button disabled until finalizePlaylistLoad confirms no active download
    btnDownloadZip.disabled = true;

    return videos;
  } catch (e) {
    console.error('[Popup] Failed to load playlist:', e);
    setStatus('Failed to load playlist: ' + e.message, 'error');
    playlistCountEl.textContent = 'Error';
    playlistVideosEl.innerHTML =
      '<div style="padding: 20px; text-align: center; color: #d32f2f;">Failed to load playlist</div>';
    return null;
  }
}

/**
 * Phase 2 of playlist init: language/settings fetch + progress restore, then
 * enable the ZIP button and stamp the final status.
 *
 * These two awaits used to run SEQUENTIALLY behind a status that already said
 * "Loaded N videos" — the reported grey-button-with-no-feedback window
 * (2026-09-25). They are independent, so they now run in parallel and the
 * status says what is actually happening ("Fetching languages…", spinner on).
 *
 * @param {Array} videos - videos returned by loadPlaylistVideos (non-null).
 * @param {{reloaded?: boolean}} [opts]
 */
async function finalizePlaylistLoad(videos, { reloaded = false } = {}) {
  const langReady = (async () => {
    setStatus('Fetching languages…', 'info', true);
    // Fetch languages from first video to populate playlist language dropdown
    if (videos.length > 0) {
      await fetchPlaylistLanguages(videos[0].videoId);
    }
    // Populate target language dropdown for translation
    populatePlaylistTargetLanguageSelect();
    // Restore saved settings now that dropdowns are populated
    loadPlaylistSettings();
  })();

  // Restore may claim the status line (running/stopped/zip-delivery states);
  // if so, never overwrite it with a generic "Loaded".
  const statusOwned = await checkAndRestoreProgress();
  await langReady;

  const selected = currentPlaylistVideos.filter(v => v.selected).length;
  btnDownloadZip.disabled = (selected === 0) || (currentDownloadId !== null);

  if (!statusOwned && currentDownloadId === null) {
    const verb = reloaded ? 'Reloaded' : 'Loaded';
    setStatus(
      `${verb} ${videos.length} videos` +
        (currentPlaylistTitle ? ' from "' + currentPlaylistTitle + '"' : ''),
      'success'
    );
  }
}

async function fetchPlaylistLanguages(videoId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_VIDEO_METADATA',
      videoId
    });

    if (response && response.success) {
      const { languages } = response.data;
      if (languages && languages.length > 0) {
        populatePlaylistLanguageSelect(languages);
        return;
      }
    }
  } catch (e) {
    console.log('[Popup] Could not fetch languages for playlist:', e);
  }
  // Fallback: always populate with full language list so the dropdown isn't empty
  console.log('[Popup] Metadata failed, using full language list as fallback');
  populatePlaylistLanguageSelect(SUPPORTED_LANGUAGES.map(l => ({ code: l.code, name: l.name })));
}

function populatePlaylistLanguageSelect(languages, selectedValue = 'auto') {
  // Keep the "Auto" option (not pre-selected, let caller decide)
  playlistLangSelect.innerHTML = '<option value="auto">Auto (first available)</option>';

  if (languages && languages.length > 0) {
    languages.forEach(lang => {
      const option = document.createElement('option');
      option.value = lang.code;
      option.text = `${lang.name} ${lang.isAuto ? '(Auto)' : ''}`;
      playlistLangSelect.add(option);
    });
  }

  // Restore saved value if provided and exists in options
  if (selectedValue) {
    const option = Array.from(playlistLangSelect.options).find(o => o.value === selectedValue);
    if (option) {
      playlistLangSelect.value = selectedValue;
    }
  }
}

function populatePlaylistTargetLanguageSelect(selectedValue = 'ru') {
  if (!playlistTranslateLang) return;

  playlistTranslateLang.innerHTML = '';

  SUPPORTED_LANGUAGES.forEach(lang => {
    const option = document.createElement('option');
    option.value = lang.code;
    option.text = lang.name;
    playlistTranslateLang.add(option);
  });

  // Restore saved value if provided and exists in options
  if (selectedValue) {
    const option = Array.from(playlistTranslateLang.options).find(o => o.value === selectedValue);
    if (option) {
      playlistTranslateLang.value = selectedValue;
    }
  }
}

function renderPlaylistVideos() {
  console.log('[Popup] Rendering videos:', currentPlaylistVideos.length);
  playlistVideosEl.innerHTML = '';

  if (currentPlaylistVideos.length === 0) {
    playlistVideosEl.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No videos found</div>';
    return;
  }

  for (const video of currentPlaylistVideos) {
    const item = document.createElement('div');
    item.className = 'playlist-video-item';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = video.selected;
    checkbox.dataset.videoId = video.videoId;
    checkbox.addEventListener('change', (e) => {
      video.selected = e.target.checked;
      updateSelectedCount();
      // Sync master checkbox: checked only if ALL videos are selected
      const allSelected = currentPlaylistVideos.every(v => v.selected);
      selectAllCheck.checked = allSelected;
    });
    
    const indexSpan = document.createElement('span');
    indexSpan.className = 'video-index';
    const arrayIndex = currentPlaylistVideos.indexOf(video);
    const indexValue = video.index ?? (arrayIndex >= 0 ? arrayIndex + 1 : '?');
    indexSpan.textContent = String(indexValue).padStart(2, '0');
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'video-info';
    
    const titleSpan = document.createElement('span');
    titleSpan.className = 'video-title';
    titleSpan.textContent = video.title;
    titleSpan.title = video.title;
    
    const durationSpan = document.createElement('span');
    durationSpan.className = 'video-duration';
    durationSpan.textContent = video.duration;
    
    infoDiv.appendChild(titleSpan);
    infoDiv.appendChild(durationSpan);
    
    item.appendChild(checkbox);
    item.appendChild(indexSpan);
    item.appendChild(infoDiv);
    
    playlistVideosEl.appendChild(item);
  }
}

function updateSelectedCount() {
  const selected = currentPlaylistVideos.filter(v => v.selected).length;
  selectedCountEl.textContent = `${selected} selected`;
  // Keep button disabled if download is in progress, even if items are selected
  btnDownloadZip.disabled = (selected === 0) || (currentDownloadId !== null);
}

let currentDownloadId = null;
let progressCheckInterval = null;
let isDownloadingZip = false; // Guard to prevent concurrent ZIP downloads

/**
 * Centralized cleanup for download-related state.
 * Ensures consistent state reset across all code paths.
 */
function resetDownloadState() {
  // Stop any active polling
  if (progressCheckInterval) {
    clearInterval(progressCheckInterval);
    progressCheckInterval = null;
  }
  // Reset download tracking
  currentDownloadId = null;
  releaseZipDownloadLock();
  // Reset stop button for the next batch
  if (btnStopDownload) {
    btnStopDownload.disabled = false;
    btnStopDownload.textContent = 'Stop';
  }
}

/**
 * Atomic guard for ZIP download operations.
 * Returns true if lock was acquired, false if already downloading.
 * This prevents race conditions between checkAndRestoreProgress and polling.
 */
function tryAcquireZipDownloadLock() {
  if (isDownloadingZip) {
    return false;
  }
  isDownloadingZip = true;
  return true;
}

/**
 * Release the ZIP download lock.
 * Should be called in finally blocks to ensure cleanup.
 */
function releaseZipDownloadLock() {
  isDownloadingZip = false;
}

/**
 * Staleness guard: a non-terminal progress record whose writer has been
 * silent longer than STALE_PROGRESS_MS means the service worker died
 * mid-batch (or a stop was lost) — nothing will ever update it again.
 * Treat it as 'stopped' so the UI (Download button, polling) recovers
 * instead of soft-locking on this playlist forever.
 */
const STALE_PROGRESS_MS = 60000;
function effectiveProgress(p) {
  if (!p || !p.status) return p;
  const terminal = p.status === 'completed' || p.status === 'error' || p.status === 'stopped';
  if (terminal) return p;
  // Records with NO updatedAt are pre-upgrade (orphaned by a version that
  // predates the stamp) — treat them as stale too, else a stuck 'running'
  // from before the upgrade survives forever, which is the exact soft-lock
  // this guard exists to break.
  if (!p.updatedAt || Date.now() - p.updatedAt > STALE_PROGRESS_MS) {
    return { ...p, status: 'stopped', stale: true };
  }
  return p;
}

/**
 * Stopped-state ZIP recovery: when chrome.downloads.download failed during a
 * stop, the partial ZIP is parked in storage under downloadId. Deliver it
 * (downloadCompletedZip also schedules the storage-key cleanup) before the
 * progress record is cleared, otherwise the key is orphaned forever.
 * Pre-checks storage so the 0-success stop (no ZIP at all) doesn't flash
 * downloadCompletedZip's "Failed to download ZIP" error.
 * Returns tri-state:
 *   'none'      — nothing parked (safe to clear the progress record)
 *   'delivered' — parked ZIP handed to the browser (safe to clear)
 *   'failed'    — parked ZIP exists but delivery failed: DO NOT clear the
 *                 record, or the only pointer to the ZIP is lost forever.
 */
async function recoverStoppedZip(progress) {
  if (progress.swDownloaded || progress.stoppedSaved || !progress.downloadId) return 'none';
  try {
    const result = await chrome.storage.local.get(progress.downloadId);
    if (!result[progress.downloadId]) return 'none';
  } catch (e) {
    console.log('[Popup] Storage check for stopped ZIP failed:', e.message);
    return 'none';
  }
  if (!tryAcquireZipDownloadLock()) {
    // Contention: another delivery is in progress — that is NOT "nothing
    // parked". Report 'failed' so the caller keeps the record until the
    // in-flight delivery decides (success clears, failure keeps).
    return 'failed';
  }
  try {
    // Swallows its own errors internally and returns whether it delivered.
    const delivered = await downloadCompletedZip(progress.downloadId);
    if (!delivered) {
      appendPlaylistLog('Stored partial ZIP existed but delivery FAILED — progress kept for retry');
    }
    return delivered ? 'delivered' : 'failed';
  } finally {
    releaseZipDownloadLock();
  }
}

async function downloadPlaylistSubtitles() {
  // Prevent concurrent downloads
  if (currentDownloadId !== null) {
    console.log('[Popup] Download already in progress, ignoring click');
    appendPlaylistLog('Download already in progress, ignoring click');
    return;
  }

  const selectedVideos = currentPlaylistVideos.filter(v => v.selected);
  if (selectedVideos.length === 0) return;

  // Determine format and language from playlist UI controls
  const format = playlistFormatSelect?.value || 'srt';
  const sourceLang = playlistLangSelect?.value || 'auto';
  const shouldTranslate = playlistTranslateCheck?.checked || false;
  const targetLang = playlistTranslateLang?.value || 'en';

  console.log('[Popup] Starting download:', {
    playlistId: currentPlaylistId,
    videoCount: selectedVideos.length,
    format,
    sourceLang,
    translate: shouldTranslate,
    targetLang
  });

  // Log playlist download start
  appendPlaylistLog(`=== Playlist Download Started ===`);
  appendPlaylistLog(`Playlist ID: ${currentPlaylistId}`);
  appendPlaylistLog(`Videos: ${selectedVideos.length}`);
  appendPlaylistLog(`Format: ${format}, Source: ${sourceLang}${shouldTranslate ? ` → Target: ${targetLang}` : ''}`);

  setStatus(`Starting download of ${selectedVideos.length} subtitles...`, 'info', true);
  btnDownloadZip.disabled = true;
  playlistProgressEl.classList.remove('hidden');

  // Capture the tab the user is on RIGHT NOW: the background pins this as
  // the batch's driver tab. Resolving "active tab" later (after a cold
  // service-worker wake) could pick a tab the user switched to meanwhile.
  let clickTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    clickTabId = tab?.id ?? null;
  } catch (e) {
    console.warn('[Popup] Could not capture click-time tab:', e.message);
  }

  try {
    // Start batch download in background
    console.log('[Popup] Sending BATCH_DOWNLOAD_PLAYLIST message...');
    const response = await chrome.runtime.sendMessage({
      type: 'BATCH_DOWNLOAD_PLAYLIST',
      videos: selectedVideos,
      playlistId: currentPlaylistId,
      playlistTitle: currentPlaylistTitle,
      tabId: clickTabId,
      options: {
        format,
        sourceLang,
        translate: shouldTranslate,
        targetLang
      }
    });
    console.log('[Popup] Got response:', response);

    if (!response || !response.success) {
      console.log('[Popup] Response check failed:', response);
      throw new Error(response?.error || 'Failed to start batch download');
    }

    if (!response.data || !response.data.downloadId) {
      console.log('[Popup] Response missing data or downloadId:', response);
      throw new Error(response?.error || 'Failed to start batch download: missing downloadId');
    }

    currentDownloadId = response.data.downloadId;
    console.log('[Popup] Download started, ID:', currentDownloadId);

    // Start polling for progress with total video count
    console.log('[Popup] Calling startProgressPolling with:', selectedVideos.length, 'videos');
    startProgressPolling(selectedVideos.length);

  } catch (err) {
    console.error('[Popup] Download start error:', err);
    appendPlaylistLog(`=== Download Start Failed ===`);
    appendPlaylistLog(`Error: ${err.message}`);
    setStatus('Failed to start download: ' + err.message, 'error');
    btnDownloadZip.disabled = false;
    playlistProgressEl.classList.add('hidden');
  }
}

/**
 * Restore any persisted batch state into the UI.
 * @returns {Promise<boolean>} statusOwned — true when this function claimed the
 * status line (any running/stopping/stopped/completed/error branch, plus the
 * zip-lock-skip path, where polling owns the line). Callers must NOT stamp a
 * generic "Loaded…" over an owned status.
 */
async function checkAndRestoreProgress() {
  let statusOwned = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_DOWNLOAD_PROGRESS'
    });

    if (!response || !response.success) return false;

    const progress = effectiveProgress(response.data);
    if (!progress || progress.playlistId !== currentPlaylistId) return false;
    // Also verify downloadId to avoid restoring stale batches
    if (progress.downloadId && currentDownloadId && progress.downloadId !== currentDownloadId) return false;

    // If there's an active or completed download, restore UI
    if (progress.status === 'running' || progress.status === 'completed' || progress.status === 'error' ||
        progress.status === 'stopping' || progress.status === 'stopped') {
      console.log('[Popup] Restoring progress:', progress);

      // Show progress UI
      playlistProgressEl.classList.remove('hidden');
      btnDownloadZip.disabled = true;

      // Update progress display
      if (progress.total > 0) {
        const percent = (progress.completed / progress.total) * 100;
        progressFillEl.style.width = `${percent}%`;
        progressFillEl.setAttribute('aria-valuenow', Math.round(percent));
        progressFillEl.setAttribute('aria-valuetext', `${progress.completed} of ${progress.total}`);
        progressTextEl.textContent = `${progress.completed} / ${progress.total}`;
      }

      // Handle different statuses
      if (progress.status === 'running') {
        // Set guard to prevent concurrent downloads (only if we have a valid downloadId)
        if (progress.downloadId) {
          currentDownloadId = progress.downloadId;
        }
        startProgressPolling(progress.total);
        setStatus(`Downloading... ${progress.completed}/${progress.total}`, 'info', true);
        statusOwned = true;
      } else if (progress.status === 'stopping') {
        if (progress.downloadId) {
          currentDownloadId = progress.downloadId;
        }
        btnStopDownload.disabled = true;
        btnStopDownload.textContent = 'Stopping…';
        startProgressPolling(progress.total);
        setStatus(`Stopping… ${progress.completed}/${progress.total}`, 'info', true);
        statusOwned = true;
      } else if (progress.status === 'stopped') {
        const recovery = await recoverStoppedZip(progress);
        const saved = progress.swDownloaded || progress.stoppedSaved || recovery === 'delivered';
        setStatus(`Stopped — ${progress.completed}/${progress.total} done${saved ? ' (partial ZIP saved)' : ''}`, 'info');
        btnDownloadZip.disabled = false;
        playlistProgressEl.classList.add('hidden');
        try {
          // Never clear when a parked ZIP failed to deliver — the record is
          // the only pointer to it (retry happens on next popup open).
          if (recovery !== 'failed') {
            await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
          } else {
            setStatus('Stopped — ZIP could not be delivered; reopen the popup to retry', 'error');
          }
        } finally {
          resetDownloadState();
        }
        return true;
      } else if (progress.status === 'completed' && progress.downloadId) {
        if (progress.swDownloaded) {
          // SW already downloaded the file
          console.log('[Popup] Restoring completed state (SW downloaded)');
          setStatus(`Saved! ${progress.completed - (progress.failed || 0)}/${progress.total} subtitles`, 'success');
          btnDownloadZip.disabled = false;
          playlistProgressEl.classList.add('hidden');
          await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
          resetDownloadState();
          return true;
        }
        // Atomic guard: acquire lock or skip
        if (!tryAcquireZipDownloadLock()) {
          console.log('[Popup] ZIP download already in progress from polling, skipping');
          // Polling owns the status line here (it will report the delivery).
          return true;
        }

        try {
          const delivered = await downloadCompletedZip(progress.downloadId);
          if (delivered) {
            await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
          } else {
            // Keep the record — it is the only pointer to the parked ZIP.
            setStatus('ZIP could not be delivered; reopen the popup to retry', 'error');
          }
        } catch (err) {
          console.error('[Popup] Failed to handle completed ZIP:', err);
        } finally {
          resetDownloadState();
        }
        // downloadCompletedZip always stamps a status (delivered or failed).
        statusOwned = true;
      } else if (progress.status === 'error') {
        // Error occurred
        setStatus(`Download failed: ${progress.error || 'Unknown error'}`, 'error');
        btnDownloadZip.disabled = false;
        playlistProgressEl.classList.add('hidden');

        try {
          await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
        } finally {
          resetDownloadState();
        }
        statusOwned = true;
      }
      // `completed` WITHOUT downloadId falls through every branch and sets no
      // status — statusOwned stays false so the caller may stamp its own.
    }
    return statusOwned;
  } catch (err) {
    console.error('[Popup] Failed to restore progress:', err);
    return statusOwned;
  }
}

function startProgressPolling(totalVideos) {
  console.log('[Popup] startProgressPolling called with totalVideos:', totalVideos);
  console.log('[Popup] currentPlaylistId:', currentPlaylistId);

  // Clear any existing polling
  if (progressCheckInterval) {
    clearInterval(progressCheckInterval);
    progressCheckInterval = null;
  }

  // Reset UI to initial state - ALWAYS set initial text
  const initialTotal = totalVideos || 0;
  progressFillEl.style.width = '0%';
  progressFillEl.setAttribute('aria-valuenow', '0');
  progressFillEl.setAttribute('aria-valuetext', `0 of ${initialTotal || '?'}`);
  progressTextEl.textContent = `0 / ${initialTotal || '?'}`;
  console.log('[Popup] Initial progress set to: 0 /', initialTotal || '?');

  // Poll every 500ms for progress updates
  progressCheckInterval = setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_DOWNLOAD_PROGRESS'
      });

      if (!response || !response.success) {
        console.log('[Popup] No progress response');
        return;
      }

      const progress = effectiveProgress(response.data);
      console.log('[Popup] Got progress:', progress);

      if (!progress) {
        console.log('[Popup] Progress is null');
        return;
      }

      if (progress.playlistId !== currentPlaylistId) {
        console.log('[Popup] Playlist ID mismatch:', progress.playlistId, '!==', currentPlaylistId);
        // Stop polling and reset state
        resetDownloadState();
        btnDownloadZip.disabled = currentPlaylistVideos.filter(v => v.selected).length === 0;
        // Hide progress UI since we're on wrong playlist
        playlistProgressEl.classList.add('hidden');
        return;
      }

      // Update UI
      if (progress.total > 0) {
        const percent = (progress.completed / progress.total) * 100;
        progressFillEl.style.width = `${percent}%`;
        progressFillEl.setAttribute('aria-valuenow', Math.round(percent));
        progressFillEl.setAttribute('aria-valuetext', `${progress.completed} of ${progress.total}`);
        progressTextEl.textContent = `${progress.completed} / ${progress.total}`;
        console.log(`[Popup] UI updated: ${progress.completed}/${progress.total} (${percent.toFixed(1)}%)`);

        // Log progress every 10% or on status change
        if (progress.status === 'running') {
          const prevPercent = parseInt(progressFillEl.getAttribute('data-last-logged') || '0');
          if (percent - prevPercent >= 10 || progress.current) {
            appendPlaylistLog(`Progress: ${progress.completed}/${progress.total} (${percent.toFixed(0)}%) - ${progress.failed || 0} failed`);
            if (progress.current) {
              appendPlaylistLog(`  Processing: ${progress.current}`);
            }
            progressFillEl.setAttribute('data-last-logged', Math.floor(percent / 10) * 10);
          }
          setStatus(`Downloading... ${progress.completed}/${progress.total} (${progress.failed || 0} failed)`, 'info', true);
        }

        if (progress.status === 'stopping') {
          btnStopDownload.disabled = true;
          btnStopDownload.textContent = 'Stopping…';
          setStatus(`Stopping… ${progress.completed}/${progress.total}`, 'info', true);
        }
      } else {
        console.log('[Popup] Total is 0, cannot calculate progress');
      }

      // Check if completed
      if (progress.status === 'completed' && progress.downloadId) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;

        appendPlaylistLog(`=== Download Completed ===`);
        appendPlaylistLog(`Success: ${progress.completed - (progress.failed || 0)} / ${progress.total}`);
        if (progress.failed > 0) {
          appendPlaylistLog(`Failed: ${progress.failed}`);
        }

        if (progress.swDownloaded) {
          // SW already triggered the download via chrome.downloads.download
          appendPlaylistLog('ZIP saved via browser download');
          setStatus(`Saved! ${progress.completed - (progress.failed || 0)}/${progress.total} subtitles`, 'success');
          btnDownloadZip.disabled = false;
          playlistProgressEl.classList.add('hidden');
          await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
          resetDownloadState();
          return;
        }

        // Atomic guard: acquire lock or skip
        if (!tryAcquireZipDownloadLock()) {
          console.log('[Popup] ZIP download already in progress, skipping');
          appendPlaylistLog('ZIP download already in progress, skipping');
          return;
        }

        try {
          appendPlaylistLog('Downloading ZIP file...');
          const delivered = await downloadCompletedZip(progress.downloadId);
          if (delivered) {
            appendPlaylistLog('ZIP download completed');
            await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
          } else {
            appendPlaylistLog('ZIP delivery FAILED — progress kept for retry on next popup open');
            setStatus('ZIP could not be delivered; reopen the popup to retry', 'error');
          }
        } catch (err) {
          console.error('[Popup] Polling completion error:', err);
          appendPlaylistLog(`Error downloading ZIP: ${err.message}`);
        } finally {
          resetDownloadState();
        }
      }

      // Check if stopped by the user
      if (progress.status === 'stopped') {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;

        const recovery = await recoverStoppedZip(progress);
        const saved = progress.swDownloaded || progress.stoppedSaved || recovery === 'delivered';

        appendPlaylistLog(`=== Download Stopped ===`);
        if (progress.stale) {
          appendPlaylistLog('Progress record was stale (service worker went quiet) — recovered as stopped');
        }
        appendPlaylistLog(`Progress: ${progress.completed}/${progress.total}`);
        if (progress.failed > 0) {
          appendPlaylistLog(`Failed before stop: ${progress.failed}`);
        }
        if (saved) {
          appendPlaylistLog('Partial ZIP saved to Downloads');
        }

        setStatus(`Stopped — ${progress.completed}/${progress.total} done${saved ? ' (partial ZIP saved)' : ''}`, 'info');
        btnDownloadZip.disabled = false;
        playlistProgressEl.classList.add('hidden');

        try {
          // Never clear when a parked ZIP failed to deliver — the record is
          // the only pointer to it (retry happens on next popup open).
          if (recovery !== 'failed') {
            await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
          } else {
            setStatus('Stopped — ZIP could not be delivered; reopen the popup to retry', 'error');
          }
        } finally {
          resetDownloadState();
        }
        return;
      }

      // Check if error occurred
      if (progress.status === 'error') {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;

        appendPlaylistLog(`=== Download Failed ===`);
        appendPlaylistLog(`Error: ${progress.error || 'Unknown error'}`);
        appendPlaylistLog(`Progress at failure: ${progress.completed}/${progress.total}`);

        setStatus(`Download failed: ${progress.error || 'Unknown error'}`, 'error');
        btnDownloadZip.disabled = false;
        playlistProgressEl.classList.add('hidden');

        try {
          await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
        } finally {
          resetDownloadState();
        }

        console.error('[Popup] Download error:', progress);
      }
    } catch (err) {
      console.error('Progress polling error:', err);
    }
  }, 500);
}

async function downloadCompletedZip(downloadId) {
  try {
    // Get ZIP data from storage
    const result = await chrome.storage.local.get(downloadId);
    const downloadData = result[downloadId];

    if (!downloadData) {
      throw new Error('Download data not found');
    }

    // Convert base64 to blob
    const binaryString = atob(downloadData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/zip' });

    // Download via blob URL (respects filename)
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadData.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Defer revocation to avoid race with download start in popup context
    // Use 30s to ensure download has started even on slow connections
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    setStatus(
      `Downloaded successfully!`,
      'success'
    );

    // DEFERRED CLEANUP: Wait 5 minutes before removing from storage
    // to ensure user had time to save it even if OS was slow.
    setTimeout(async () => {
      try {
        await chrome.storage.local.remove(downloadId);
        console.log(`[Popup] Cleaned up storage for ${downloadId}`);
      } catch (e) {
        console.warn(`[Popup] Failed to clean up ${downloadId}:`, e);
      }
    }, 300000);

    return true;
  } catch (err) {
    setStatus('Failed to download ZIP: ' + err.message, 'error');
    return false;
  } finally {
    btnDownloadZip.disabled = false;
    playlistProgressEl.classList.add('hidden');
    resetDownloadState();
  }
}

// Playlist event listeners
selectAllCheck?.addEventListener('change', (e) => {
  const checked = e.target.checked;
  currentPlaylistVideos.forEach(v => v.selected = checked);
  
  // Update all checkboxes
  const checkboxes = playlistVideosEl.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = checked);
  
  updateSelectedCount();
});

btnDownloadZip?.addEventListener('click', downloadPlaylistSubtitles);

// Stop an in-progress batch download (cooperative — background cancels at
// its next checkpoint and reports status 'stopping' → 'stopped').
btnStopDownload?.addEventListener('click', async () => {
  btnStopDownload.disabled = true;
  btnStopDownload.textContent = 'Stopping…';
  appendPlaylistLog('Stop requested — cancelling remaining videos...');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'STOP_BATCH_DOWNLOAD' });
    if (!resp?.success) {
      appendPlaylistLog(`Stop failed: ${resp?.error || 'no response'}`);
      btnStopDownload.disabled = false;
      btnStopDownload.textContent = 'Stop';
    }
  } catch (err) {
    appendPlaylistLog(`Stop error: ${err.message}`);
    btnStopDownload.disabled = false;
    btnStopDownload.textContent = 'Stop';
  }
});

// Playlist translation toggle
function updatePlaylistTranslationState() {
  const enabled = playlistTranslateCheck?.checked || false;
  if (playlistTranslateLang) {
    playlistTranslateLang.disabled = !enabled;
  }

  if (enabled) {
    playlistTranslationOptions?.classList.add('visible');
  } else {
    playlistTranslationOptions?.classList.remove('visible');
  }
}

function savePlaylistSettings() {
  if (!currentPlaylistId) {
    console.log('[Popup] Skipping savePlaylistSettings - no current playlist');
    return;
  }
  const keys = {
    [`playlist:${currentPlaylistId}:translateChecked`]: playlistTranslateCheck?.checked,
    [`playlist:${currentPlaylistId}:targetLanguage`]: playlistTranslateLang?.value,
    [`playlist:${currentPlaylistId}:sourceLanguage`]: playlistLangSelect?.value,
    [`playlist:${currentPlaylistId}:format`]: playlistFormatSelect?.value
  };
  chrome.storage.local.set(keys);
  console.log(`[Popup] Saved playlist settings for ${currentPlaylistId}`);
}

function loadPlaylistSettings() {
  if (!currentPlaylistId) {
    console.log('[Popup] Skipping loadPlaylistSettings - no current playlist');
    return;
  }
  const keys = [
    `playlist:${currentPlaylistId}:translateChecked`,
    `playlist:${currentPlaylistId}:targetLanguage`,
    `playlist:${currentPlaylistId}:sourceLanguage`,
    `playlist:${currentPlaylistId}:format`
  ];
  chrome.storage.local.get(keys, (result) => {
    const translateChecked = result[`playlist:${currentPlaylistId}:translateChecked`];
    const targetLanguage = result[`playlist:${currentPlaylistId}:targetLanguage`];
    const sourceLanguage = result[`playlist:${currentPlaylistId}:sourceLanguage`];
    const format = result[`playlist:${currentPlaylistId}:format`];

    if (translateChecked !== undefined && playlistTranslateCheck) {
      playlistTranslateCheck.checked = translateChecked;
      updatePlaylistTranslationState();
    }
    if (targetLanguage && playlistTranslateLang) {
      const option = Array.from(playlistTranslateLang.options).find(o => o.value === targetLanguage);
      if (option) {
        playlistTranslateLang.value = targetLanguage;
      }
    }
    if (sourceLanguage && playlistLangSelect) {
      const option = Array.from(playlistLangSelect.options).find(o => o.value === sourceLanguage);
      if (option) {
        playlistLangSelect.value = sourceLanguage;
      }
    }
    if (format && playlistFormatSelect) {
      const option = Array.from(playlistFormatSelect.options).find(o => o.value === format);
      if (option) {
        playlistFormatSelect.value = format;
      }
    }
    console.log(`[Popup] Loaded playlist settings for ${currentPlaylistId}`);
  });
}

playlistTranslateCheck?.addEventListener('change', () => {
  updatePlaylistTranslationState();
  savePlaylistSettings();
});

playlistTranslateLang?.addEventListener('change', savePlaylistSettings);
playlistLangSelect?.addEventListener('change', savePlaylistSettings);
playlistFormatSelect?.addEventListener('change', savePlaylistSettings);

// Note: loadPlaylistSettings is called from finalizePlaylistLoad, after the
// language dropdowns are populated (restoring a source language needs the
// options to exist).

async function fetchLanguages(videoId) {
  setStatus('Fetching languages...', 'info', true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_VIDEO_METADATA',
      videoId
    });

    if (response && response.success) {
      const { languages, title } = response.data;
      
      if (title && title !== 'YouTube Video') {
        currentVideoTitle = title;
      } else {
        // Try to get title from page tab as fallback
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.title && tab.title !== 'YouTube') {
            currentVideoTitle = tab.title.replace(' - YouTube', '').replace('YouTube', '').trim();
          }
        } catch (e) {
          console.log('Could not get tab title:', e);
        }
      }
      
      // Set full title as tooltip for hover
      setStatus(`Ready: ${currentVideoTitle ? currentVideoTitle.substring(0, 50) : 'Video'}...`);
      statusEl.title = currentVideoTitle || 'Video';
      populateLanguageSelect(languages);
      enableControls(true);
    } else {
      throw new Error(response.error || 'Failed to fetch languages');
    }
  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
    console.error(e);
    // Fallback? No, we need languages.
    langSelect.innerHTML = '<option disabled>Error loading languages</option>';
  }
}

function populateLanguageSelect(languages) {
  langSelect.innerHTML = '';
  
  if (languages.length === 0) {
    const option = document.createElement('option');
    option.text = 'No subtitles found';
    option.disabled = true;
    langSelect.add(option);
    return;
  }

  languages.forEach(lang => {
    const option = document.createElement('option');
    option.value = lang.code;
    option.text = `${lang.name} ${lang.isAuto ? '(Auto)' : ''}`;
    langSelect.add(option);
  });
  
  // Try to find English or first available
  const preferred = languages.find(l => l.code === 'en' && !l.isAuto) || languages[0];
  if (preferred) {
    langSelect.value = preferred.code;
  }
}

function populateTargetLanguageSelect() {
    translateLang.innerHTML = '';
    
    // Default to Russian if available, otherwise English
    let defaultLang = 'ru';
    
    SUPPORTED_LANGUAGES.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang.code;
        option.text = lang.name;
        translateLang.add(option);
    });

    translateLang.value = defaultLang;
}

function saveSettings() {
  chrome.storage.local.set({
    translateChecked: translateCheck.checked,
    targetLanguage: translateLang.value
  });
}

function loadSettings() {
  chrome.storage.local.get(['translateChecked', 'targetLanguage'], (result) => {
    if (result.translateChecked !== undefined) {
      translateCheck.checked = result.translateChecked;
      updateTranslationState();
    }
    if (result.targetLanguage) {
      // Ensure the value exists in options before setting
      const option = Array.from(translateLang.options).find(o => o.value === result.targetLanguage);
      if (option) {
        translateLang.value = result.targetLanguage;
      }
    }
  });
}

// Initialize target languages immediately
populateTargetLanguageSelect();
loadSettings();

async function fetchAndDownload(format) {
  if (!currentVideoId) return;
  
  const lang = langSelect.value;
  const shouldTranslate = translateCheck.checked;
  const targetLanguage = translateLang.value;

  setStatus(`Fetching subtitles (${lang}${shouldTranslate ? ' -> ' + targetLanguage : ''})...`, 'info', true);
  enableControls(false);

  try {
    // Send message to background
    const response = await chrome.runtime.sendMessage({
      type: 'GET_TRANSCRIPT',
      videoId: currentVideoId,
      options: { 
        lang,
        translate: shouldTranslate,
        targetLang: targetLanguage
      }
    });

    if (response && response.success) {
      currentTranscript = response.data;
      showLogs(response.logs);
      setStatus(`Subtitles fetched! Converting...`, 'success');
      
      let content = '';
      let ext = '';
      let mime = 'text/plain';

      if (format === 'srt') {
        content = toSRT(currentTranscript);
        ext = 'srt';
      } else if (format === 'vtt') {
        content = toVTT(currentTranscript);
        ext = 'vtt';
        mime = 'text/vtt';
      } else {
        content = toTXT(currentTranscript);
        ext = 'txt';
      }

      const filenameLang = shouldTranslate ? targetLanguage : lang;
      
      let safeTitle = 'video';
      if (currentVideoTitle) {
        // Sanitize title: remove illegal characters for filenames
        safeTitle = currentVideoTitle
          .replace(/[<>:"/\\|?*]/g, '') // Remove illegal chars
          .replace(/\s+/g, '_')         // Replace spaces with underscores
          .substring(0, 50);            // Limit length
      }
      
      const filename = `${safeTitle}_${currentVideoId}_${filenameLang}.${ext}`;
      downloadFile(content, filename, mime);
      setStatus('Done!', 'success');
    } else {
      if (response && response.logs) {
        showLogs(response.logs);
      }
      throw new Error(response.error || 'Unknown error');
    }
  } catch (e) {
    setStatus('Failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    enableControls(true);
  }
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation to avoid race with download start in popup context
  // Use 30s to ensure download has started even on slow connections
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Event Listeners
btnSrt.addEventListener('click', () => fetchAndDownload('srt'));
btnVtt.addEventListener('click', () => fetchAndDownload('vtt'));
btnTxt.addEventListener('click', () => fetchAndDownload('txt'));

translateCheck.addEventListener('change', () => {
  updateTranslationState();
  saveSettings();
});

translateLang.addEventListener('change', saveSettings);

  logsToggle.addEventListener('click', () => {
    logsContainer.classList.toggle('open');
  });

  btnCopyLogs.addEventListener('click', () => {
  const logs = logsEl.value;
  navigator.clipboard.writeText(logs).then(() => {
    const originalText = btnCopyLogs.textContent;
    btnCopyLogs.textContent = 'Copied!';
    setTimeout(() => {
      btnCopyLogs.textContent = originalText;
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy logs: ', err);
  });
});

// Reset Button Logic
btnReset.addEventListener('click', async () => {
  // Animate button
  const icon = btnReset.querySelector('svg');
  icon.style.transition = 'transform 0.5s ease';
  icon.style.transform = 'rotate(360deg)';
  setTimeout(() => icon.style.transform = '', 500);

  // Handle playlist mode
  if (isPlaylistMode && currentPlaylistId) {
    setStatus('Reloading playlist...', 'info', true);
    try {
      // Clear playlist UI and reset state
      playlistVideosEl.innerHTML = '';
      currentPlaylistVideos = [];
      resetDownloadState();

      // Re-fetch playlist; on failure loadPlaylistVideos has already stamped
      // the error status — do NOT clobber it with "Reloaded 0 videos".
      const videos = await loadPlaylistVideos(currentPlaylistId);
      if (videos) {
        await finalizePlaylistLoad(videos, { reloaded: true });
      }
    } catch (e) {
      setStatus('Reload failed: ' + e.message, 'error');
      console.error(e);
    }
    return;
  }

  // Handle single video mode
  if (!currentVideoId) return;

  setStatus('Resetting cache...', 'info', true);
  enableControls(false);

  try {
    // 1. Clear cache in background
    await chrome.runtime.sendMessage({
      type: 'CLEAR_CACHE',
      videoId: currentVideoId
    });

    // 2. Clear local state
    currentVideoTitle = null;
    currentTranscript = null;
    langSelect.innerHTML = '<option disabled selected>Reloading...</option>';

    // 3. Re-fetch languages (force refresh)
    await fetchLanguages(currentVideoId);

  } catch (e) {
    setStatus('Reset failed: ' + e.message, 'error');
    console.error(e);
  }
});

// Initialize
init();
