import { ACTIVE_STATUSES, STATUS } from '../shared/constants.js';

const elements = {
  controls: document.querySelector('#controls'),
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
  actionError: document.querySelector('#actionError'),
  openPanel: document.querySelector('#openPanel'),
  openDiagnostics: document.querySelector('#openDiagnostics'),
  openAudio: document.querySelector('#openAudio'),
  openKey: document.querySelector('#openKey'),
  openStats: document.querySelector('#openStats'),
  openFeedback: document.querySelector('#openFeedback'),
  audioOverlay: document.querySelector('#audioOverlay'),
  keyOverlay: document.querySelector('#keyOverlay')
};

const translations = {
  ar: {
    title: 'دبلجة', setupEyebrow: 'الإعداد الأول', addKey: 'أضف مفتاح Gemini', keyHint: 'ألصق مفتاح API الخاص بك للوصول إلى ميزات دبلجة أكثر.',
    apiKey: 'مفتاح API', pasteKey: 'ألصق المفتاح هنا', show: 'إظهار', hide: 'إخفاء', consent: 'أوافق على إرسال صوت التبويب ونصوصه مؤقتاً إلى Google Gemini لإنتاج الدبلجة والترجمة. لا تحفظ الإضافة الصوت أو النصوص.',
    saveKey: 'حفظ', geminiKey: 'مفتاح API', savedLocal: '•••••••• محفوظ محلياً', testKey: 'اختبار', change: 'تغيير', delete: 'حذف', clearKey: 'مسح', deleteKey: 'حذف المفتاح', or: 'أو',
    originalAudio: 'الصوت الأصلي', originalHelp: 'اخفضه كي يبقى الكلام الإنجليزي مرجعاً هادئاً.', dubbedAudio: 'الصوت العربي', audioBalance: 'الصوت', audioBalanceHelp: 'اجعل الدبلجة واضحة مع إبقاء المصدر مرجعاً هادئاً.', autoDucking: 'خفض الصوت الأصلي تلقائياً',
    autoDuckingHelp: 'يخفضه بسلاسة أثناء كلام الدبلجة ثم يعيده.', usageStats: 'الإحصائيات', totalDubbed: 'إجمالي الدبلجة', sessions: 'جلسات', activeDays: 'أيام نشطة', averageDelay: 'متوسط التأخير', details: 'عرض التفاصيل', openCaptions: 'فتح الترجمة الثنائية', clearPrivacy: 'خصوصية واضحة',
    privacySummary: 'يُرسل صوت التبويب مباشرةً إلى Google فقط أثناء الجلسة.', privacyPolicy: 'سياسة الخصوصية', start: 'ابدأ الدبلجة', stop: 'إيقاف الدبلجة'
  },
  en: {
    title: 'دبلجة', setupEyebrow: 'First setup', addKey: 'Add your Gemini key', keyHint: 'Paste your API key to unlock more dubbing features.',
    apiKey: 'API key', pasteKey: 'Paste the key here', show: 'Show', hide: 'Hide', consent: 'I agree to send the current tab audio and temporary transcripts to Google Gemini to produce dubbing and captions. The extension does not store audio or transcripts.',
    saveKey: 'Save', geminiKey: 'API key', savedLocal: '•••••••• stored locally', testKey: 'Test', change: 'Change', delete: 'Delete', clearKey: 'Clear', deleteKey: 'Delete key', or: 'or',
    originalAudio: 'Original audio', originalHelp: 'Keep the English speech audible as a quiet reference.', dubbedAudio: 'Arabic dubbed audio', audioBalance: 'Audio', audioBalanceHelp: 'Keep the Arabic dub clear with a quiet source reference.', autoDucking: 'Automatically duck original audio',
    autoDuckingHelp: 'Smoothly lowers it while Arabic speech plays, then restores it.', usageStats: 'Usage stats', totalDubbed: 'Total dubbed', sessions: 'Sessions', activeDays: 'Active days', averageDelay: 'Average delay', details: 'View details', openCaptions: 'Open bilingual captions', clearPrivacy: 'Clear privacy',
    privacySummary: 'Tab audio goes directly to Google only during a session.', privacyPolicy: 'Privacy policy', start: 'Start dubbing', stop: 'Stop dubbing'
  }
};

const statusLabels = {
  ar: {
    [STATUS.NO_KEY]: 'مفتاح Gemini مطلوب', [STATUS.READY]: 'جاهز للبدء', [STATUS.CONNECTING]: 'جارٍ الاتصال', [STATUS.LISTENING]: 'أستمع الآن',
    [STATUS.TRANSLATING]: 'الدبلجة تعمل', [STATUS.RECONNECTING]: 'إعادة الاتصال', [STATUS.RATE_LIMITED]: 'حد مؤقت للخدمة', [STATUS.STOPPED]: 'متوقف', [STATUS.ERROR]: 'تحتاج الجلسة إلى انتباه'
  },
  en: {
    [STATUS.NO_KEY]: 'Gemini key required', [STATUS.READY]: 'Ready', [STATUS.CONNECTING]: 'Connecting', [STATUS.LISTENING]: 'Listening',
    [STATUS.TRANSLATING]: 'Dubbing live', [STATUS.RECONNECTING]: 'Reconnecting', [STATUS.RATE_LIMITED]: 'Temporarily rate limited', [STATUS.STOPPED]: 'Stopped', [STATUS.ERROR]: 'Session needs attention'
  }
};

const KEY_MASK = '••••••••••••••••••••';

let currentState = null;
let settings = null;
let busy = false;
let keyEdited = false;

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

function englishStatusMessage() {
  const messages = {
    [STATUS.NO_KEY]: 'Enter and consent to use a Gemini API key first.',
    [STATUS.READY]: 'Open an audible English-speaking tab, then start dubbing.',
    [STATUS.CONNECTING]: 'Capturing the tab and connecting to Gemini…',
    [STATUS.LISTENING]: currentState.sourcePaused ? 'Connected—the source is silent or paused.' : 'Listening to the current tab…',
    [STATUS.TRANSLATING]: 'Arabic dubbing is playing now.',
    [STATUS.RECONNECTING]: 'The connection dropped temporarily. Retrying…',
    [STATUS.RATE_LIMITED]: 'Google temporarily rate limited the session. Retrying safely…',
    [STATUS.STOPPED]: 'Dubbing is stopped and tab audio is restored.',
    [STATUS.ERROR]: currentState.diagnosticCode ? `Gemini session error (${currentState.diagnosticCode}). Open diagnostics for details.` : 'The session stopped with an error. Open diagnostics for details.'
  };
  return messages[currentState.status] || 'Unknown session state.';
}

function showError(message = '') {
  elements.keyError.textContent = message;
  elements.keyError.classList.toggle('hidden', !message);
}

function showActionError(message = '') {
  elements.actionError.textContent = message;
  elements.actionError.classList.toggle('hidden', !message);
}

async function getActiveWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error(language() === 'en' ? 'Open a regular web page with audio first.' : 'افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  if (tab.url && !/^https?:/.test(tab.url)) {
    throw new Error(language() === 'en' ? 'Open a regular web page with audio first.' : 'افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  }
  return tab;
}

async function captureActiveTab() {
  const tab = await getActiveWebTab();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  return { tabId: tab.id, tabUrl: tab.url || '', streamId };
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

function renderVolumes() {
  const originalPercent = Math.round((settings?.originalVolume ?? 0.25) * 100);
  const dubbedPercent = Math.round((settings?.dubbedVolume ?? 1) * 100);
  elements.originalVolume.value = String(originalPercent);
  elements.dubbedVolume.value = String(dubbedPercent);
  elements.originalOutput.textContent = formatPercent(originalPercent);
  elements.dubbedOutput.textContent = formatPercent(dubbedPercent);
  elements.autoDucking.checked = settings?.autoDucking !== false;
}

function render() {
  if (!currentState || !settings) return;
  const active = ACTIVE_STATUSES.has(currentState.status);
  applyLanguage();
  const label = elements.startStop.querySelector('.cta-label');
  if (label) label.textContent = active ? tr('stop') : tr('start');
  else elements.startStop.textContent = active ? tr('stop') : tr('start');
  elements.startStop.classList.toggle('stop', active);
  elements.startStop.disabled = busy;
  fillSavedKeyField();
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'تعذر تنفيذ الطلب.');
  if (response.state) currentState = response.state;
  if (response.settings) settings = response.settings;
  return response;
}

async function refresh() {
  const response = await request({ type: 'GET_STATE' });
  currentState = response.state;
  settings = response.settings;
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
        apiKey,
        consent: true
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

elements.startStop.addEventListener('click', async () => {
  if (!settings?.hasKey || !settings?.hasConsent) {
    toggleOverlay(elements.keyOverlay);
    return;
  }
  setBusy(true);
  showActionError();
  try {
    if (ACTIVE_STATUSES.has(currentState.status)) {
      await request({ type: 'STOP_SESSION' });
    } else {
      const response = await request({ type: 'START_SESSION', ...(await captureActiveTab()) });
      if (response.state && !ACTIVE_STATUSES.has(response.state.status) && response.state.message) {
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

elements.autoDucking.addEventListener('change', async () => {
  const enabled = elements.autoDucking.checked;
  await request({ type: 'SET_AUTO_DUCKING', enabled }).catch(() => undefined);
  settings = { ...settings, autoDucking: enabled };
});

for (const [kind, slider, output] of [
  ['original', elements.originalVolume, elements.originalOutput],
  ['dubbed', elements.dubbedVolume, elements.dubbedOutput]
]) {
  slider.addEventListener('input', () => {
    output.textContent = formatPercent(slider.value);
  });
  slider.addEventListener('change', async () => {
    const value = Number(slider.value) / 100;
    await request({ type: 'SET_VOLUME', kind, value }).catch(() => undefined);
    settings = { ...settings, [kind === 'original' ? 'originalVolume' : 'dubbedVolume']: value };
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
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') });
});
elements.openFeedback?.addEventListener('click', async () => {
  try {
    const response = await request({ type: 'GET_FEEDBACK_URL', source: 'popup' });
    if (response.url) await chrome.tabs.create({ url: response.url });
  } catch {}
});

elements.openPanel.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
});

elements.openDiagnostics.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/diagnostics/diagnostics.html') });
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
});

refresh().catch((error) => {
  currentState = { status: STATUS.ERROR, message: error.message };
  settings = { hasKey: false, hasConsent: false, originalVolume: 0.25, dubbedVolume: 1, autoDucking: true, uiLanguage: 'ar' };
  render();
});
