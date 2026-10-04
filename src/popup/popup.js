import { ACTIVE_STATUSES, STATUS } from '../shared/constants.js';

const elements = {
  apiKey: document.querySelector('#apiKey'),
  keyError: document.querySelector('#keyError'),
  toggleKey: document.querySelector('#toggleKey'),
  saveKey: document.querySelector('#saveKey'),
  clearKey: document.querySelector('#clearKey'),
  originalVolume: document.querySelector('#originalVolume'),
  dubbedVolume: document.querySelector('#dubbedVolume'),
  originalOutput: document.querySelector('#originalOutput'),
  dubbedOutput: document.querySelector('#dubbedOutput'),
  autoDucking: document.querySelector('#autoDucking'),
  startStop: document.querySelector('#startStop'),
  sessionStatus: document.querySelector('#sessionStatus'),
  quickBookmark: document.querySelector('#quickBookmark'),
  actionError: document.querySelector('#actionError'),
  openAudio: document.querySelector('#openAudio'),
  openKey: document.querySelector('#openKey'),
  openStats: document.querySelector('#openStats'),
  openLibrary: document.querySelector('#openLibrary'),
  audioOverlay: document.querySelector('#audioOverlay'),
  keyOverlay: document.querySelector('#keyOverlay')
};

const translations = {
  ar: {
    title: 'دبلجة', keyHint: 'ألصق مفتاح Gemini الخاص بك لبدء الدبلجة. لا يُرسل الصوت إلا بعد ضغط «ابدأ الدبلجة».',
    apiKey: 'مفتاح API', pasteKey: 'ألصق المفتاح هنا', show: 'إظهار', hide: 'إخفاء',
    saveKey: 'حفظ', geminiKey: 'مفتاح API', deleteKey: 'حذف المفتاح', or: 'أو',
    originalAudio: 'الصوت الأصلي', dubbedAudio: 'الصوت العربي', audioBalance: 'الصوت', autoDucking: 'خفض الصوت الأصلي تلقائياً',
    usageStats: 'الإحصائيات', library: 'المكتبة', start: 'ابدأ الدبلجة', stop: 'إيقاف الدبلجة',
    geminiDisclosure: 'عند بدء الدبلجة يُرسل صوت التبويب ونصوصه مباشرةً إلى Google Gemini أثناء الجلسة. يُحفظ المفتاح على هذا الجهاز فقط.'
  },
  en: {
    title: 'Dablaja', keyHint: 'Paste your Gemini API key to start dubbing. Audio is sent only after you press Start dubbing.',
    apiKey: 'API key', pasteKey: 'Paste the key here', show: 'Show', hide: 'Hide',
    saveKey: 'Save', geminiKey: 'API key', deleteKey: 'Delete key', or: 'or',
    originalAudio: 'Original audio', dubbedAudio: 'Arabic dubbed audio', audioBalance: 'Audio', autoDucking: 'Automatically duck original audio',
    usageStats: 'Usage stats', library: 'Library', start: 'Start dubbing', stop: 'Stop dubbing',
    geminiDisclosure: 'When dubbing starts, tab audio and transcripts go directly to Google Gemini for that session. The key stays on this device.'
  }
};

const statusLabels = {
  ar: {
    [STATUS.NO_KEY]: 'مفتاح Gemini مطلوب', [STATUS.CONNECTING]: 'جارٍ الاتصال', [STATUS.LISTENING]: 'أستمع الآن',
    [STATUS.RECONNECTING]: 'إعادة الاتصال', [STATUS.RATE_LIMITED]: 'حد مؤقت للخدمة', [STATUS.ERROR]: 'تحتاج الجلسة إلى انتباه'
  },
  en: {
    [STATUS.NO_KEY]: 'Gemini key required', [STATUS.CONNECTING]: 'Connecting', [STATUS.LISTENING]: 'Listening',
    [STATUS.RECONNECTING]: 'Reconnecting', [STATUS.RATE_LIMITED]: 'Temporarily rate limited', [STATUS.ERROR]: 'Session needs attention'
  }
};

const KEY_MASK = '••••••••••••••••••••';

let currentState = null;
let settings = null;
let librarySettings = null;
let activeTabOrigin = null;
let busy = false;
let keyEdited = false;
let activeOriginPromise = null;

function language() {
  return settings?.uiLanguage === 'en' ? 'en' : 'ar';
}

function tr(key) {
  return translations[language()][key] || translations.ar[key] || key;
}

function applyLanguage() {
  const lang = language();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = tr(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = tr(node.dataset.i18nPlaceholder);
  elements.toggleKey.setAttribute('aria-label', tr(elements.apiKey.type === 'text' ? 'hide' : 'show'));
  elements.clearKey.setAttribute('aria-label', tr('deleteKey'));
  elements.clearKey.title = tr('deleteKey');
}

function showError(message = '') {
  elements.keyError.textContent = message;
  elements.keyError.classList.toggle('hidden', !message);
}

function showActionError(message = '') {
  elements.actionError.textContent = message;
  elements.actionError.classList.toggle('hidden', !message);
}

async function resolveActiveTabOrigin() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) {
      const url = new URL(tab.url);
      activeTabOrigin = url.hostname;
    }
  } catch {}
  return activeTabOrigin;
}

async function getActiveWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error(language() === 'en' ? 'Open a regular web page with audio first.' : 'افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  if (tab.url && !/^https?:/.test(tab.url)) {
    throw new Error(language() === 'en' ? 'Open a regular web page with audio first.' : 'افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  }
  return tab;
}

async function activeTabStartOptions() {
  const tab = await getActiveWebTab();
  return { tabId: tab.id, tabUrl: tab.url || '', tabTitle: tab.title || '' };
}

function setBusy(value) {
  busy = value;
  elements.startStop.disabled = value;
  elements.saveKey.disabled = value;
  elements.clearKey.disabled = value;
}

function formatPercent(value) {
  const rounded = String(Math.round(Number(value) || 0));
  if (language() === 'en') return `${rounded}%`;
  return `${rounded.replace(/[0-9]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'[digit])}٪`;
}

function isMaskedKeyValue(value = elements.apiKey.value) {
  return value === KEY_MASK || /^•+$/.test(String(value).trim());
}

function fillSavedKeyField() {
  if (!settings?.hasKey || keyEdited) return;
  elements.apiKey.type = 'password';
  elements.apiKey.value = KEY_MASK;
}

const volumeInteraction = {
  original: { dragging: false, touched: false, sequence: 0 },
  dubbed: { dragging: false, touched: false, sequence: 0 }
};

function renderVolumes() {
  // While a session runs with a site profile applied, the
  // sliders reflect the EFFECTIVE volumes, not the global defaults.
  const active = currentState && ACTIVE_STATUSES.has(currentState.status);
  let effectiveOriginal = settings?.originalVolume ?? 0.25;
  let effectiveDubbed = settings?.dubbedVolume ?? 1;

  if (active && currentState?.sessionVolumes) {
    if (currentState.sessionVolumes.original != null) effectiveOriginal = currentState.sessionVolumes.original;
    if (currentState.sessionVolumes.dubbed != null) effectiveDubbed = currentState.sessionVolumes.dubbed;
  } else if (activeTabOrigin && Array.isArray(librarySettings?.siteProfiles)) {
    const profile = librarySettings.siteProfiles.find((p) => p.origin === activeTabOrigin);
    if (profile) {
      if (Number.isFinite(profile.originalVolume)) effectiveOriginal = profile.originalVolume;
      if (Number.isFinite(profile.dubbedVolume)) effectiveDubbed = profile.dubbedVolume;
    }
  }

  const originalPercent = Math.round(effectiveOriginal * 100);
  const dubbedPercent = Math.round(effectiveDubbed * 100);
  if (!volumeInteraction.original.dragging && !volumeInteraction.original.touched) {
    elements.originalVolume.value = String(originalPercent);
    elements.originalOutput.textContent = formatPercent(originalPercent);
  }
  if (!volumeInteraction.dubbed.dragging && !volumeInteraction.dubbed.touched) {
    elements.dubbedVolume.value = String(dubbedPercent);
    elements.dubbedOutput.textContent = formatPercent(dubbedPercent);
  }
  elements.autoDucking.checked = settings?.autoDucking !== false;
}

function render() {
  if (!currentState || !settings) return;
  const active = ACTIVE_STATUSES.has(currentState.status);
  applyLanguage();
  renderVolumes();
  const label = elements.startStop.querySelector('.cta-label');
  if (label) label.textContent = active ? tr('stop') : tr('start');
  else elements.startStop.textContent = active ? tr('stop') : tr('start');
  elements.startStop.classList.toggle('stop', active);
  elements.startStop.disabled = busy;
  if (elements.sessionStatus) {
    const quietState = [STATUS.READY, STATUS.STOPPED, STATUS.TRANSLATING].includes(currentState.status);
    const paused = currentState.status === STATUS.LISTENING && currentState.sourcePaused;
    elements.sessionStatus.hidden = quietState;
    elements.sessionStatus.textContent = quietState
      ? ''
      : (paused
          ? (language() === 'en' ? 'Connected · source paused or silent' : 'متصل · المصدر متوقف أو صامت')
          : (statusLabels[language()][currentState.status] || statusLabels.ar[currentState.status] || '—'));
  }
  if (elements.quickBookmark) {
    elements.quickBookmark.classList.toggle('hidden', !active);
    // If local saving disabled, show hint on bookmark
    if (active && librarySettings && librarySettings.localSavingEnabled === false) {
      elements.quickBookmark.title = 'حفظ الجلسات المحلي معطّل — فعّله من الإعدادات';
    } else {
      elements.quickBookmark.title = '';
    }
  }
  fillSavedKeyField();
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'تعذر تنفيذ الطلب.');
  if (response.state) currentState = response.state;
  if (response.settings) settings = response.settings;
  if (response.librarySettings) librarySettings = response.librarySettings;
  return response;
}

async function refresh() {
  await resolveActiveTabOrigin();
  const response = await request({ type: 'GET_STATE' });
  currentState = response.state;
  settings = response.settings;
  librarySettings = response.librarySettings;
  renderVolumes();
  render();
}

elements.toggleKey.addEventListener('click', async () => {
  if (elements.apiKey.type === 'text') {
    elements.apiKey.type = 'password';
    if (!keyEdited && settings?.hasKey) fillSavedKeyField();
    elements.toggleKey.setAttribute('aria-label', tr('show'));
    return;
  }
  if (isMaskedKeyValue() || (!elements.apiKey.value.trim() && settings?.hasKey)) {
    try {
      const response = await request({ type: 'GET_API_KEY' });
      const storedKey = String(response.apiKey || '');
      if (!storedKey) return;
      elements.apiKey.value = storedKey;
    } catch (error) {
      showError(error.message);
      return;
    }
  }
  elements.apiKey.type = 'text';
  elements.toggleKey.setAttribute('aria-label', tr('hide'));
});

elements.apiKey.addEventListener('focus', () => {
  if (isMaskedKeyValue()) {
    elements.apiKey.value = '';
    keyEdited = false;
  }
});

elements.apiKey.addEventListener('input', () => {
  keyEdited = Boolean(elements.apiKey.value.trim());
});

elements.apiKey.addEventListener('blur', () => {
  if (!elements.apiKey.value.trim() && settings?.hasKey) {
    keyEdited = false;
    fillSavedKeyField();
  }
});

let savePromise = null;

function closeKeyOverlay() {
  elements.keyOverlay.classList.add('hidden');
}

async function saveEnteredKey() {
  const apiKey = elements.apiKey.value.trim();
  if (isMaskedKeyValue(apiKey) || (!apiKey && settings?.hasKey)) {
    showError();
    return true;
  }
  if (!apiKey) {
    showError(language() === 'en' ? 'Paste a Gemini API key first.' : 'ألصق مفتاح Gemini أولاً.');
    return false;
  }
  if (savePromise) return savePromise;
  showError();
  savePromise = (async () => {
    setBusy(true);
    try {
      const response = await request({
        type: 'SAVE_KEY',
        apiKey
      });
      settings = response.settings;
      keyEdited = false;
      renderVolumes();
      render();
      closeKeyOverlay();
      return true;
    } catch (error) {
      showError(error.message);
      render();
      return false;
    } finally {
      savePromise = null;
      setBusy(false);
    }
  })();
  return savePromise;
}

elements.saveKey.addEventListener('click', async (event) => {
  event.preventDefault();
  await saveEnteredKey();
});

elements.apiKey.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveEnteredKey();
  }
});

elements.clearKey.addEventListener('click', async () => {
  elements.apiKey.value = '';
  keyEdited = false;
  showError();
  if (!settings?.hasKey) {
    elements.apiKey.focus();
    return;
  }
  setBusy(true);
  try {
    const response = await request({ type: 'DELETE_KEY' });
    settings = response.settings;
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
    render();
    elements.apiKey.focus();
  }
});

function triggerSavedAnimation() {
  if (!elements.openLibrary) return;
  elements.openLibrary.classList.remove('library-saved-animate');
  void elements.openLibrary.offsetWidth;
  elements.openLibrary.classList.add('library-saved-animate');
  setTimeout(() => {
    elements.openLibrary.classList.remove('library-saved-animate');
  }, 4000);
}

async function openExtensionPage(relativePath) {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(relativePath) });
    return true;
  } catch (error) {
    showActionError(error?.message || 'تعذر فتح الصفحة. حاول مجدداً.');
    return false;
  }
}

elements.startStop.addEventListener('click', async () => {
  if (!settings?.hasKey) {
    toggleOverlay(elements.keyOverlay);
    return;
  }
  setBusy(true);
  showActionError();
  try {
    if (ACTIVE_STATUSES.has(currentState.status)) {
      const response = await request({ type: 'STOP_SESSION' });
      if (response?.state) currentState = response.state;
      else currentState = { status: STATUS.STOPPED };
      // Saved animation only after confirmed persistence
      if (response?.saved === true) {
        triggerSavedAnimation();
      }
    } else {
      const capture = await activeTabStartOptions();
      const response = await request({ type: 'START_SESSION', ...capture });
      if (response?.state) currentState = response.state;
      if (response?.state && !ACTIVE_STATUSES.has(response.state.status) && response.state.message) {
        showActionError(response.state.message);
      }
    }
  } catch (error) {
    showActionError(error.message);
  } finally {
    setBusy(false);
    render();
  }
});

if (elements.quickBookmark) {
  elements.quickBookmark.addEventListener('click', async () => {
    try {
      elements.quickBookmark.disabled = true;
      await request({ type: 'LIBRARY_ADD_BOOKMARK', note: '' });
      const origHtml = elements.quickBookmark.innerHTML;
      elements.quickBookmark.innerHTML = '<span>تم حفظ اللحظة! ✓</span>';
      setTimeout(() => {
        elements.quickBookmark.innerHTML = origHtml;
        elements.quickBookmark.disabled = false;
      }, 1600);
    } catch (err) {
      elements.quickBookmark.disabled = false;
      showActionError(err.message);
    }
  });
}

elements.autoDucking.addEventListener('change', async () => {
  const enabled = elements.autoDucking.checked;
  elements.autoDucking.disabled = true;
  try {
    await request({ type: 'SET_AUTO_DUCKING', enabled });
    settings = { ...settings, autoDucking: enabled };
  } catch (error) {
    elements.autoDucking.checked = !enabled;
    showActionError(error?.message || 'تعذر حفظ إعداد خفض الصوت. حاول مجدداً.');
  } finally {
    elements.autoDucking.disabled = false;
  }
});

async function getActiveOrigin() {
  if (activeTabOrigin) return activeTabOrigin;
  if (!activeOriginPromise) {
    activeOriginPromise = resolveActiveTabOrigin().finally(() => {
      activeOriginPromise = null;
    });
  }
  return activeOriginPromise;
}

const volumeCommitters = new Map();

function queueVolumeCommit(kind, value, origin, { immediate = false } = {}) {
  let commit = volumeCommitters.get(kind);
  if (!commit) {
    commit = { timer: null, inFlight: null, pending: null };
    volumeCommitters.set(kind, commit);
  }
  commit.pending = { value, origin };
  clearTimeout(commit.timer);
  commit.timer = null;

  const drain = async () => {
    if (commit.inFlight || !commit.pending) return commit.inFlight;
    const payload = commit.pending;
    commit.pending = null;
    commit.inFlight = request({ type: 'SET_VOLUME', kind, value: payload.value, origin: payload.origin })
      .then((response) => {
        if (response?.librarySettings) librarySettings = response.librarySettings;
        return response;
      })
      .catch((error) => {
        showActionError(error?.message || 'تعذر حفظ مستوى الصوت. حاول مجدداً.');
      })
      .finally(async () => {
        commit.inFlight = null;
        if (commit.pending) await drain();
      });
    return commit.inFlight;
  };

  if (immediate) return drain();
  commit.timer = setTimeout(drain, 45);
  return null;
}

for (const [kind, slider, output] of [
  ['original', elements.originalVolume, elements.originalOutput],
  ['dubbed', elements.dubbedVolume, elements.dubbedOutput]
]) {
  const interaction = volumeInteraction[kind];
  slider.addEventListener('pointerdown', () => {
    interaction.dragging = true;
    interaction.touched = true;
  });
  slider.addEventListener('pointerup', () => { interaction.dragging = false; });
  slider.addEventListener('pointercancel', () => { interaction.dragging = false; });
  slider.addEventListener('input', () => {
    output.textContent = formatPercent(slider.value);
    const value = Number(slider.value) / 100;
    const sequence = ++interaction.sequence;
    interaction.touched = true;
    settings = { ...settings, [kind === 'original' ? 'originalVolume' : 'dubbedVolume']: value };
    void getActiveOrigin().then((origin) => {
      // Ignore an older tab lookup that completed after the thumb moved again.
      if (sequence === interaction.sequence) queueVolumeCommit(kind, value, origin);
    });
  });
  slider.addEventListener('change', async () => {
    interaction.dragging = false;
    const value = Number(slider.value) / 100;
    ++interaction.sequence;
    interaction.touched = true;
    settings = { ...settings, [kind === 'original' ? 'originalVolume' : 'dubbedVolume']: value };
    const origin = await getActiveOrigin();
    await queueVolumeCommit(kind, value, origin, { immediate: true });
  });
}

function toggleOverlay(overlay) {
  const wasVisible = !overlay.classList.contains('hidden');
  for (const item of [elements.audioOverlay, elements.keyOverlay]) item.classList.add('hidden');
  elements.openAudio.classList.remove('active');
  elements.openKey.classList.remove('active');
  const shell = document.querySelector('.shell');
  if (!wasVisible) {
    overlay.classList.remove('hidden');
    if (overlay === elements.audioOverlay) elements.openAudio.classList.add('active');
    if (overlay === elements.keyOverlay) elements.openKey.classList.add('active');
  }
  shell?.classList.toggle('sheet-open', !wasVisible);
}

elements.openAudio.addEventListener('click', () => toggleOverlay(elements.audioOverlay));
elements.openKey.addEventListener('click', () => {
  elements.keyError.classList.add('hidden');
  toggleOverlay(elements.keyOverlay);
});
elements.openStats.addEventListener('click', async () => {
  await openExtensionPage('src/stats/stats.html');
});
elements.openLibrary.addEventListener('click', async () => {
  await openExtensionPage('src/library/library.html');
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_CHANGED' && message.state) {
    currentState = message.state;
    render();
    if (message.state.status === STATUS.ERROR && message.state.message) {
      showActionError(message.state.message);
    } else if (ACTIVE_STATUSES.has(message.state.status)) {
      showActionError();
    }
  }
  if (message?.type === 'UI_LANGUAGE_CHANGED') {
    settings = { ...settings, uiLanguage: message.language };
    render();
  }
  if (message?.type === 'LIBRARY_STORAGE_WARNING') {
    showActionError(message.message || (language() === 'en'
      ? 'Could not preserve the local recovery snapshot.'
      : 'تعذر حفظ نسخة الاسترجاع المحلية مؤقتاً على هذا الجهاز.'));
  }
});

refresh().catch((error) => {
  currentState = { status: STATUS.ERROR, message: error.message };
  settings = { hasKey: false, originalVolume: 0.25, dubbedVolume: 1, autoDucking: true, uiLanguage: 'ar' };
  render();
});
