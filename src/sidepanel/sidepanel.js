import { ACTIVE_STATUSES, STATUS, STORAGE_KEYS } from '../shared/constants.js';
import { mergeCaptionText, shouldFinalizeCaption } from '../shared/caption-utils.js';

const panelStatus = document.querySelector('#panelStatus');
const emptyState = document.querySelector('#emptyState');
const captions = document.querySelector('#captions');
const sourceFeed = document.querySelector('#sourceFeed');
const targetFeed = document.querySelector('#targetFeed');
const latency = document.querySelector('#latency');
const durationValue = document.querySelector('#durationValue');
const captionCountValue = document.querySelector('#captionCountValue');
const latencyValue = document.querySelector('#latencyValue');
const durationLabel = document.querySelector('#durationLabel');
const captionCountLabel = document.querySelector('#captionCountLabel');
const latencyLabel = document.querySelector('#latencyLabel');
const languageToggle = document.querySelector('#languageToggle');
let uiLanguage = 'ar';
let sessionStartedAt = null;
let captionCount = 0;
const streams = {
  source: { feed: sourceFeed, lastText: '', lastAt: 0, currentLine: null },
  target: { feed: targetFeed, lastText: '', lastAt: 0, currentLine: null }
};

function formatDuration() {
  if (!sessionStartedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderStats(state = {}) {
  const delay = state.latencyMs == null ? '—' : `≈${state.latencyMs}ms`;
  durationValue.textContent = formatDuration();
  captionCountValue.textContent = String(captionCount);
  latencyValue.textContent = delay;
  latency.textContent = state.latencyMs == null
    ? (uiLanguage === 'en' ? 'Observed latency: —' : 'التأخير المرصود: —')
    : (uiLanguage === 'en' ? `Observed latency: ≈${state.latencyMs}ms` : `التأخير المرصود: ≈${state.latencyMs}ms`);
}

function renderState(state) {
  const active = ACTIVE_STATUSES.has(state.status);
  if (active && !sessionStartedAt) sessionStartedAt = Date.now();
  const names = uiLanguage === 'en' ? {
    [STATUS.CONNECTING]: 'Connecting', [STATUS.LISTENING]: state.sourcePaused ? 'Source paused' : 'Listening', [STATUS.TRANSLATING]: 'Live dubbing',
    [STATUS.RECONNECTING]: 'Reconnecting', [STATUS.RATE_LIMITED]: 'Rate limited', [STATUS.ERROR]: 'Error', [STATUS.READY]: 'Ready', [STATUS.STOPPED]: 'Stopped', [STATUS.NO_KEY]: 'Key required'
  } : {
    [STATUS.CONNECTING]: 'جارٍ الاتصال',
    [STATUS.LISTENING]: state.sourcePaused ? 'المصدر متوقف' : 'أستمع',
    [STATUS.TRANSLATING]: 'دبلجة مباشرة',
    [STATUS.RECONNECTING]: 'إعادة الاتصال',
    [STATUS.RATE_LIMITED]: 'حد مؤقت',
    [STATUS.ERROR]: 'خطأ',
    [STATUS.READY]: 'جاهز',
    [STATUS.STOPPED]: 'متوقف',
    [STATUS.NO_KEY]: 'المفتاح مطلوب'
  };
  panelStatus.textContent = names[state.status] || 'متوقف';
  panelStatus.className = `status-pill${active ? ' active' : ''}${state.status === STATUS.ERROR ? ' error' : ''}`;
  renderStats(state);
}

function applyLanguage(language) {
  uiLanguage = language === 'en' ? 'en' : 'ar';
  document.documentElement.lang = uiLanguage;
  document.documentElement.dir = uiLanguage === 'en' ? 'ltr' : 'rtl';
  const english = uiLanguage === 'en';
  document.querySelector('#panelTitle').textContent = english ? 'Bilingual captions' : 'الترجمة الثنائية';
  document.querySelector('#emptyTitle').textContent = english ? 'Live words will appear here' : 'ستظهر الكلمات هنا مباشرةً';
  document.querySelector('#emptyCopy').textContent = english ? 'Start dubbing from the extension popup, then play an English video or webinar.' : 'ابدأ الدبلجة من نافذة الإضافة، ثم شغّل فيديو أو ندوة باللغة الإنجليزية.';
  document.querySelector('#sourceHeading').textContent = english ? 'Original transcript' : 'النص الأصلي';
  document.querySelector('#targetHeading').textContent = english ? 'Arabic translation' : 'الترجمة العربية';
  document.querySelector('#retentionNote').textContent = english
    ? 'No audio is stored; transcripts save locally only via Plus'
    : 'لا يُحفظ الصوت؛ والنصوص تُحفظ محلياً فقط عبر Plus';
  durationLabel.textContent = english ? 'Session' : 'مدة الجلسة';
  captionCountLabel.textContent = english ? 'Lines' : 'السطور';
  latencyLabel.textContent = english ? 'Delay' : 'التأخير';
  languageToggle.textContent = english ? 'العربية' : 'English';
  applyPlusLanguage();
  renderStats();
}

function clearCaptions() {
  for (const stream of Object.values(streams)) {
    stream.feed.replaceChildren();
    stream.lastText = '';
    stream.lastAt = 0;
    stream.currentLine = null;
  }
  captionCount = 0;
  sessionStartedAt = null;
  renderStats();
  captions.classList.add('hidden');
  emptyState.classList.remove('hidden');
}

function addCaption(channel, text, final = false, speaker = '') {
  const stream = streams[channel];
  const clean = String(text || '').trim();
  if (!stream) return;
  if (!clean && final && stream.currentLine) {
    stream.currentLine.classList.add('final');
    stream.currentLine = null;
    stream.lastText = '';
    return;
  }
  if (!clean) return;
  const now = Date.now();
  let last = stream.currentLine;

  if (last) {
    stream.lastText = mergeCaptionText(stream.lastText, clean);
    last.textContent = stream.lastText;
  } else {
    last = document.createElement('p');
    last.className = 'caption-line';
    last.textContent = clean;
    if (speaker) last.dataset.speaker = speaker;
    stream.feed.append(last);
    stream.currentLine = last;
    stream.lastText = clean;
    while (stream.feed.children.length > 50) stream.feed.firstElementChild.remove();
  }
  stream.lastAt = now;
  if (shouldFinalizeCaption(stream.lastText, final)) {
    last.classList.add('final');
    stream.currentLine = null;
    stream.lastText = '';
    captionCount += 1;
    renderStats();
  }
  emptyState.classList.add('hidden');
  captions.classList.remove('hidden');
  stream.feed.scrollTop = stream.feed.scrollHeight;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_CHANGED' && message.state) renderState(message.state);
  if (message?.type === 'CAPTION') {
    if (message.clear) clearCaptions();
    else addCaption(message.channel, message.text, message.final, message.speaker);
  }
  if (message?.type === 'UI_LANGUAGE_CHANGED') applyLanguage(message.language);
  if (message?.type === 'PLUS_DRAFT_CHANGED') updatePlusToolbar();
});

// ---- Dablaja Plus toolbar --------------------------------------------------

const plusToolbar = document.querySelector('#plusToolbar');
const plusSave = document.querySelector('#plusSave');
const plusLibrary = document.querySelector('#plusLibrary');
const plusBookmarkNote = document.querySelector('#plusBookmarkNote');
const plusAddBookmark = document.querySelector('#plusAddBookmark');
const plusStatus = document.querySelector('#plusStatus');
let plusDraftActive = false;
let plusStatusTimer = null;

const plusStrings = {
  ar: {
    save: 'احفظ الجلسة',
    library: 'المكتبة',
    addBookmark: 'أضف علامة الآن',
    notePlaceholder: 'ملاحظة سريعة للعلامة…',
    savedLive: 'حُفظت الجلسة وستُحدَّث حتى تتوقف الدبلجة.',
    bookmarkAdded: 'أُضيفت العلامة.',
    saveFailed: 'تعذر حفظ الجلسة.',
    bookmarkFailed: 'تعذر إضافة العلامة.',
    storageWarning: 'تحذير: تعذر حفظ مسودة الجلسة مؤقتاً على الجهاز.'
  },
  en: {
    save: 'Save session',
    library: 'Library',
    addBookmark: 'Add bookmark now',
    notePlaceholder: 'Quick bookmark note…',
    savedLive: 'Saved — the session keeps updating until dubbing stops.',
    bookmarkAdded: 'Bookmark added.',
    saveFailed: 'Could not save the session.',
    bookmarkFailed: 'Could not add the bookmark.',
    storageWarning: 'Warning: could not persist the session draft locally.'
  }
};

function plusTr(key) {
  const table = uiLanguage === 'en' ? plusStrings.en : plusStrings.ar;
  return table[key] || plusStrings.ar[key];
}

function applyPlusLanguage() {
  plusSave.textContent = plusTr('save');
  plusLibrary.textContent = plusTr('library');
  plusAddBookmark.textContent = plusTr('addBookmark');
  plusBookmarkNote.placeholder = plusTr('notePlaceholder');
}

// sendMessage resolves with { ok:false, error } instead of throwing — this
// helper turns failures into real exceptions so success is never faked.
async function plusRequest(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || 'تعذر تنفيذ الطلب.');
  }
  return response;
}

function flashPlusStatus(text) {
  plusStatus.textContent = text;
  clearTimeout(plusStatusTimer);
  plusStatusTimer = setTimeout(() => {
    if (!plusDraftActive) plusStatus.textContent = '';
  }, 4000);
}

async function updatePlusToolbar() {
  try {
    const status = await plusRequest({ type: 'PLUS_GET_STATUS' });
    // Consistent shape: `draft` IS the active draft summary (or null) and
    // `plus` is the full settings object carrying `entitlement`.
    plusDraftActive = Boolean(status.draft);
    // Strict: only an explicit plusEnabled === true shows the toolbar.
    // Missing/malformed entitlement keeps it hidden (locked by default).
    const enabled = status.plus?.entitlement?.plusEnabled === true;
    plusToolbar.classList.toggle('hidden', !enabled);
    plusSave.disabled = !plusDraftActive;
    plusAddBookmark.disabled = !plusDraftActive;
    if (status.storageWarning) {
      flashPlusStatus(plusTr('storageWarning'));
    } else if (!plusDraftActive) {
      plusStatus.textContent = '';
    }
  } catch {
    plusToolbar.classList.add('hidden');
  }
}

plusSave.addEventListener('click', async () => {
  plusSave.disabled = true;
  try {
    await plusRequest({ type: 'PLUS_SAVE_ACTIVE' });
    flashPlusStatus(plusTr('savedLive'));
  } catch (error) {
    flashPlusStatus(error?.message || plusTr('saveFailed'));
  } finally {
    plusSave.disabled = false;
    await updatePlusToolbar();
  }
});

plusAddBookmark.addEventListener('click', async () => {
  try {
    await plusRequest({
      type: 'PLUS_ADD_BOOKMARK',
      note: plusBookmarkNote.value.slice(0, 500)
    });
    plusBookmarkNote.value = '';
    flashPlusStatus(plusTr('bookmarkAdded'));
  } catch (error) {
    flashPlusStatus(error?.message || plusTr('bookmarkFailed'));
  }
});

plusBookmarkNote.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    plusAddBookmark.click();
  }
});

plusLibrary.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/library/library.html') });
});

applyPlusLanguage();

updatePlusToolbar().catch(() => undefined);

languageToggle.addEventListener('click', async () => {
  const next = uiLanguage === 'en' ? 'ar' : 'en';
  await chrome.runtime.sendMessage({ type: 'SET_UI_LANGUAGE', language: next });
  applyLanguage(next);
});

chrome.storage.local.get(STORAGE_KEYS.UI_LANGUAGE).then((stored) => {
  applyLanguage(stored[STORAGE_KEYS.UI_LANGUAGE]);
});
chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((response) => {
  if (response?.state) renderState(response.state);
}).catch(() => renderState({ status: STATUS.ERROR, latencyMs: null }));
