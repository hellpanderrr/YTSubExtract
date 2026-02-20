import { toSRT, toVTT, toTXT } from '../utils/subtitle-formats.js';
import { SUPPORTED_LANGUAGES } from '../utils/languages.js';

const statusEl = document.getElementById('status');
const statusIcon = document.getElementById('status-icon');
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
let currentTranscript = null;

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
    if (url.hostname.includes('youtube.com') && url.searchParams.has('v')) {
      currentVideoId = url.searchParams.get('v');
      setStatus(`Video found: ${currentVideoId}`);
      fetchLanguages(currentVideoId);
    } else {
      setStatus('Not a YouTube video page', 'error');
    }
  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
  }
}

async function fetchLanguages(videoId) {
  setStatus('Fetching languages...', 'info', true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_VIDEO_METADATA',
      videoId
    });

    if (response && response.success) {
      const { languages, title } = response.data;
      setStatus(`Ready: ${title.substring(0, 30)}...`);
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
      downloadFile(content, `subtitles_${currentVideoId}_${filenameLang}.${ext}`, mime);
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
  URL.revokeObjectURL(url);
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

// Initialize
init();
