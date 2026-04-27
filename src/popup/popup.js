import { toSRT, toVTT, toTXT } from '../utils/subtitle-formats.js';
import { SUPPORTED_LANGUAGES } from '../utils/languages.js';
import { isPlaylistUrl, extractPlaylistId, fetchPlaylistVideos } from '../utils/playlist-extractor.js';

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
  
  if (loading) {
    statusIcon.classList.remove('hidden');
  } else {
    statusIcon.classList.add('hidden');
  }
}

function showLogs(logs) {
  if (logs && logs.length > 0) {
    logsContainer.classList.remove('hidden');
    logsEl.value = logs.join('\n');
    // Scroll to bottom
    logsEl.scrollTop = logsEl.scrollHeight;
  }
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

      await loadPlaylistVideos(currentPlaylistId);

      // Check if there's an active download for this playlist
      await checkAndRestoreProgress();

      // Enable download button only after confirming no active download
      const selected = currentPlaylistVideos.filter(v => v.selected).length;
      btnDownloadZip.disabled = (selected === 0) || (currentDownloadId !== null);
      return;
    }
    
    // Single video mode
    if (url.hostname.includes('youtube.com') && url.searchParams.has('v')) {
      currentVideoId = url.searchParams.get('v');
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
    } else {
      btnReset.style.display = 'none';
      setStatus('Not a YouTube video or playlist page', 'error');
    }
  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
  }
}

async function loadPlaylistVideos(playlistId) {
  setStatus('Loading playlist videos...', 'info', true);
  btnDownloadZip.disabled = true;

  try {
    console.log('[Popup] Fetching playlist:', playlistId);
    const result = await fetchPlaylistVideos(playlistId, 50);
    console.log('[Popup] Got result:', result);

    const videos = result.videos || result; // Handle both old and new format
    currentPlaylistTitle = result.title || '';
    currentPlaylistVideos = videos.map((v) => ({ ...v, selected: true }));

    setStatus(`Loaded ${videos.length} videos${currentPlaylistTitle ? ' from "' + currentPlaylistTitle + '"' : ''}`, 'success');
    playlistCountEl.textContent = `${videos.length} videos`;

    renderPlaylistVideos();
    updateSelectedCount();
    // Keep button disabled initially - will enable after checkAndRestoreProgress confirms no active download
    btnDownloadZip.disabled = true;

    // Fetch languages from first video to populate playlist language dropdown
    if (videos.length > 0) {
      await fetchPlaylistLanguages(videos[0].videoId);
    }

    // Populate target language dropdown for translation
    populatePlaylistTargetLanguageSelect();

    // Restore saved settings now that dropdowns are populated
    loadPlaylistSettings();

  } catch (e) {
    console.error('[Popup] Failed to load playlist:', e);
    setStatus('Failed to load playlist: ' + e.message, 'error');
    playlistCountEl.textContent = 'Error';
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
      populatePlaylistLanguageSelect(languages);
    }
  } catch (e) {
    console.log('[Popup] Could not fetch languages for playlist:', e);
    // Fallback to SUPPORTED_LANGUAGES
    populatePlaylistLanguageSelect(SUPPORTED_LANGUAGES.map(l => ({ code: l.code, name: l.name })));
  }
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
    indexSpan.textContent = String(video.index).padStart(2, '0');
    
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

async function downloadPlaylistSubtitles() {
  // Prevent concurrent downloads
  if (currentDownloadId !== null) {
    console.log('[Popup] Download already in progress, ignoring click');
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

  setStatus(`Starting download of ${selectedVideos.length} subtitles...`, 'info', true);
  btnDownloadZip.disabled = true;
  playlistProgressEl.classList.remove('hidden');

  try {
    // Start batch download in background
    console.log('[Popup] Sending BATCH_DOWNLOAD_PLAYLIST message...');
    const response = await chrome.runtime.sendMessage({
      type: 'BATCH_DOWNLOAD_PLAYLIST',
      videos: selectedVideos,
      playlistId: currentPlaylistId,
      playlistTitle: currentPlaylistTitle,
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
    setStatus('Failed to start download: ' + err.message, 'error');
    btnDownloadZip.disabled = false;
    playlistProgressEl.classList.add('hidden');
  }
}

async function checkAndRestoreProgress() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_DOWNLOAD_PROGRESS'
    });

    if (!response || !response.success) return;

    const progress = response.data;
    if (!progress || progress.playlistId !== currentPlaylistId) return;

    // If there's an active or completed download, restore UI
    if (progress.status === 'running' || progress.status === 'completed' || progress.status === 'error') {
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
        startProgressPolling(progress.total);
        setStatus(`Downloading... ${progress.completed}/${progress.total}`, 'info', true);
      } else if (progress.status === 'completed' && progress.downloadId) {
        // Completed — download ZIP (auto-download flow not implemented)
        await downloadCompletedZip(progress.downloadId);
        await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
      } else if (progress.status === 'error') {
        // Error occurred
        setStatus(`Download failed: ${progress.error || 'Unknown error'}`, 'error');
        btnDownloadZip.disabled = false;
        playlistProgressEl.classList.add('hidden');
        currentDownloadId = null;
        await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
      }
    }
  } catch (err) {
    console.error('[Popup] Failed to restore progress:', err);
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

      const progress = response.data;
      console.log('[Popup] Got progress:', progress);

      if (!progress) {
        console.log('[Popup] Progress is null');
        return;
      }

      if (progress.playlistId !== currentPlaylistId) {
        console.log('[Popup] Playlist ID mismatch:', progress.playlistId, '!==', currentPlaylistId);
        // Stop polling to prevent resource leak
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
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

        if (progress.status === 'running') {
          setStatus(`Downloading... ${progress.completed}/${progress.total} (${progress.failed || 0} failed)`, 'info', true);
        }
      } else {
        console.log('[Popup] Total is 0, cannot calculate progress');
      }

      // Check if completed
      if (progress.status === 'completed' && progress.downloadId) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;

        // Download ZIP (auto-download flow not implemented)
        await downloadCompletedZip(progress.downloadId);

        // Clear the progress
        await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
      }

      // Check if error occurred
      if (progress.status === 'error') {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;

        setStatus(`Download failed: ${progress.error || 'Unknown error'}`, 'error');
        btnDownloadZip.disabled = false;
        playlistProgressEl.classList.add('hidden');
        currentDownloadId = null;

        console.error('[Popup] Download error:', progress);
        await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_PROGRESS' });
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
    setTimeout(() => URL.revokeObjectURL(url), 100);

    setStatus(
      `Downloaded successfully!`,
      'success'
    );

    // Clean up storage
    await chrome.storage.local.remove(downloadId);

  } catch (err) {
    setStatus('Failed to download ZIP: ' + err.message, 'error');
  } finally {
    btnDownloadZip.disabled = false;
    playlistProgressEl.classList.add('hidden');
    currentDownloadId = null;
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
  chrome.storage.local.set({
    playlistTranslateChecked: playlistTranslateCheck?.checked,
    playlistTargetLanguage: playlistTranslateLang?.value,
    playlistSourceLanguage: playlistLangSelect?.value,
    playlistFormat: playlistFormatSelect?.value
  });
}

function loadPlaylistSettings() {
  chrome.storage.local.get(['playlistTranslateChecked', 'playlistTargetLanguage', 'playlistSourceLanguage', 'playlistFormat'], (result) => {
    if (result.playlistTranslateChecked !== undefined && playlistTranslateCheck) {
      playlistTranslateCheck.checked = result.playlistTranslateChecked;
      updatePlaylistTranslationState();
    }
    if (result.playlistTargetLanguage && playlistTranslateLang) {
      const option = Array.from(playlistTranslateLang.options).find(o => o.value === result.playlistTargetLanguage);
      if (option) {
        playlistTranslateLang.value = result.playlistTargetLanguage;
      }
    }
    if (result.playlistSourceLanguage && playlistLangSelect) {
      const option = Array.from(playlistLangSelect.options).find(o => o.value === result.playlistSourceLanguage);
      if (option) {
        playlistLangSelect.value = result.playlistSourceLanguage;
      }
    }
    if (result.playlistFormat && playlistFormatSelect) {
      const option = Array.from(playlistFormatSelect.options).find(o => o.value === result.playlistFormat);
      if (option) {
        playlistFormatSelect.value = result.playlistFormat;
      }
    }
  });
}

playlistTranslateCheck?.addEventListener('change', () => {
  updatePlaylistTranslationState();
  savePlaylistSettings();
});

playlistTranslateLang?.addEventListener('change', savePlaylistSettings);
playlistLangSelect?.addEventListener('change', savePlaylistSettings);
playlistFormatSelect?.addEventListener('change', savePlaylistSettings);

// Note: loadPlaylistSettings is now called after dropdowns are populated in loadPlaylistVideos

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
      statusEl.title = currentVideoTitle || 'Video';;
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
  setTimeout(() => URL.revokeObjectURL(url), 100);
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
      // Clear playlist UI
      playlistVideosEl.innerHTML = '';
      currentPlaylistVideos = [];
      currentDownloadId = null;

      // Re-fetch playlist
      await loadPlaylistVideos(currentPlaylistId);
      await checkAndRestoreProgress();

      // Enable download button if appropriate
      const selected = currentPlaylistVideos.filter(v => v.selected).length;
      btnDownloadZip.disabled = (selected === 0) || (currentDownloadId !== null);

      setStatus(`Reloaded ${currentPlaylistVideos.length} videos`, 'success');
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
