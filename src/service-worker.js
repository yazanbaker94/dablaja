import {
  ACTIVE_STATUSES,
  DEFAULTS,
  SESSION_STATE_KEY,
  STATUS,
  STORAGE_KEYS,
  originOf,
  publicState
} from './shared/constants.js';
import { transitionState } from './shared/lifecycle.js';
import { EMPTY_USAGE_STATS, normalizeUsageStats, recordSessionEnd, recordSessionStart } from './shared/usage-stats.js';
import { configureUninstallUrl, feedbackPageUrl, reportRemoteError, reportUsageSession } from './shared/telemetry.js';
import { validateKeySave } from './shared/key-consent.js';
import { resolveEntitlement } from './shared/plus-entitlement.js';
import { createPlusDraftController } from './shared/plus-draft-controller.js';
import { createPlusMessageHandler } from './shared/plus-messages.js';
import {
  clearSavedSessions,
  deleteSavedSession,
  getSavedSession,
  listSavedSessions,
  putSavedSession,
  putSavedSessionBatch
} from './shared/plus-db.js';
import { profileForOrigin, removeProfile, upsertProfile } from './shared/site-profiles.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let state = publicState();
let creatingOffscreen = null;
let stoppingPromise = null;
let captureStatusTimer = null;
let usageStats = normalizeUsageStats(EMPTY_USAGE_STATS);
let trackedSession = null;

async function loadUsageStats() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.USAGE_STATS);
  usageStats = normalizeUsageStats(stored[STORAGE_KEYS.USAGE_STATS]);
}

async function persistUsageStats() {
  await chrome.storage.local.set({ [STORAGE_KEYS.USAGE_STATS]: usageStats });
}

const TRACKED_SESSION_KEY = 'trackedUsageSession';

async function persistTrackedSession() {
  if (trackedSession) {
    await chrome.storage.session.set({ [TRACKED_SESSION_KEY]: trackedSession });
    return;
  }
  await chrome.storage.session.remove(TRACKED_SESSION_KEY);
}

async function recordStart(startedAt, site = null) {
  usageStats = recordSessionStart(usageStats, startedAt, { site });
  trackedSession = { startedAt: startedAt || Date.now(), site: site || null };
  await persistUsageStats();
  await persistTrackedSession();
}

async function recordEnd(finalState, error = false) {
  if (!trackedSession) return;
  const startedAt = trackedSession.startedAt;
  const site = finalState?.tabOrigin || trackedSession.site;
  const sentAudioMs = Math.max(0, Number(finalState?.sentAudioMs) || 0);
  usageStats = recordSessionEnd(usageStats, {
    durationMs: Math.max(0, Date.now() - startedAt),
    sentAudioMs,
    latencyMs: finalState?.latencyMs,
    reconnectCount: finalState?.reconnectCount,
    error,
    site
  });
  trackedSession = null;
  await persistUsageStats();
  await persistTrackedSession();
  await reportUsageSession({ site, dubbedMs: sentAudioMs });
}

async function loadInitialState() {
  await loadUsageStats();
  const tracked = await chrome.storage.session.get(TRACKED_SESSION_KEY);
  trackedSession = tracked[TRACKED_SESSION_KEY] || null;
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.CONSENT,
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE,
    STORAGE_KEYS.ANALYTICS_CONSENT,
    STORAGE_KEYS.ANALYTICS_DECIDED_AT
  ]);
  const previous = await chrome.storage.session.get(SESSION_STATE_KEY);
  const previousState = previous[SESSION_STATE_KEY];
  const wasActive = ACTIVE_STATUSES.has(previousState?.status);
  // A persisted active draft can only belong to a session from before this
  // worker (re)started — that session can no longer be running. Finalize it
  // into the unsaved list immediately so it never accepts new bookmarks.
  await plusController.restore().catch(() => undefined);
  if (trackedSession) {
    await recordEnd(
      previousState || { tabOrigin: trackedSession.site },
      previousState?.status === STATUS.ERROR
    );
  }
  state = publicState({
    status: stored[STORAGE_KEYS.API_KEY] && stored[STORAGE_KEYS.CONSENT]
      ? (wasActive ? STATUS.STOPPED : STATUS.READY)
      : STATUS.NO_KEY,
    message: wasActive ? 'توقفت الجلسة بعد إعادة تحميل الإضافة.' : ''
  });
  await persistState();
  await configureUninstallUrl().catch(() => undefined);
}

const initialStateReady = loadInitialState().catch(() => undefined);

// ---------------------------------------------------------------------------
// Dablaja Plus — local session drafts and entitlement.
// Drafts live in chrome.storage.session (survives service-worker suspension,
// cleared when the browser closes). Saved sessions live in IndexedDB. No
// transcript content is ever sent to AudioFetcher or logged.
// Draft lifecycle, persistence races and byte budgets are owned by the
// adapter-injected controller; paid mutations are gated centrally in
// createPlusMessageHandler — UI disabled states are never trusted.
// ---------------------------------------------------------------------------

const plusStorageAdapter = {
  async get(key) {
    return chrome.storage.session.get(key);
  },
  async set(items) {
    return chrome.storage.session.set(items);
  },
  async remove(key) {
    return chrome.storage.session.remove(key);
  }
};

const plusLibraryAdapter = {
  get: (id) => getSavedSession(id),
  list: () => listSavedSessions(),
  put: (record) => putSavedSession(record),
  delete: (id) => deleteSavedSession(id),
  clear: () => clearSavedSessions(),
  putBatch: (records) => putSavedSessionBatch(records)
};

const plusSettingsAdapter = {
  get: () => getPlusSettings(),
  async setAutosave(value) {
    await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_AUTOSAVE]: value === true });
    return getPlusSettings();
  },
  async setRemember(value) {
    const enabled = value === true;
    await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_REMEMBER_VOLUMES]: enabled });
    // If enabled during a running session, capture both effective levels
    // immediately. The user should not have to move a slider again merely to
    // create the first per-site profile.
    if (enabled && state.tabOrigin && sessionVolumes) {
      const current = await getPlusSettings();
      const profiles = upsertProfile(current.siteProfiles, {
        origin: state.tabOrigin,
        originalVolume: sessionVolumes.original,
        dubbedVolume: sessionVolumes.dubbed
      });
      await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_SITE_PROFILES]: profiles });
    }
    return getPlusSettings();
  },
  async deleteProfile(origin) {
    const plus = await getPlusSettings();
    const profiles = removeProfile(plus.siteProfiles, origin);
    await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_SITE_PROFILES]: profiles });
    return { ...plus, siteProfiles: profiles };
  }
};

const plusController = createPlusDraftController({
  storage: plusStorageAdapter,
  db: { putSession: (record) => putSavedSession(record) },
  getEntitlement: async () => (await getPlusSettings()).entitlement
});

plusController.subscribe((event) => {
  chrome.runtime.sendMessage(event).catch(() => undefined);
});

const handlePlusMessage = createPlusMessageHandler({
  controller: plusController,
  library: plusLibraryAdapter,
  settings: plusSettingsAdapter,
  // The message boundary needs the complete settings object so it can both
  // enforce `settings.entitlement.plusEnabled` and return the same shape to
  // the library UI. Passing only the nested entitlement made every paid
  // action appear locked even during the development preview.
  entitlement: () => getPlusSettings()
});

// Effective volumes for the ACTIVE session (site-profile values when a
// profile applied). Popup sliders display these; profile updates preserve
// the other value from here instead of a stale global.
let sessionVolumes = null;

async function getPlusSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.PLUS_LICENSE,
    STORAGE_KEYS.PLUS_AUTOSAVE,
    STORAGE_KEYS.PLUS_REMEMBER_VOLUMES,
    STORAGE_KEYS.PLUS_SITE_PROFILES
  ]);
  return {
    // A plain local { state: 'active' } record is NOT verifiable evidence;
    // only the Stripe-phase verifier pipeline (or the dev-preview switch)
    // can unlock Plus. Missing/malformed data defaults to locked.
    entitlement: resolveEntitlement({ licenseRecord: stored[STORAGE_KEYS.PLUS_LICENSE] }),
    autosave: stored[STORAGE_KEYS.PLUS_AUTOSAVE] !== false,
    rememberVolumes: stored[STORAGE_KEYS.PLUS_REMEMBER_VOLUMES] !== false,
    siteProfiles: Array.isArray(stored[STORAGE_KEYS.PLUS_SITE_PROFILES])
      ? stored[STORAGE_KEYS.PLUS_SITE_PROFILES]
      : []
  };
}

// Profiles are a paid feature: never apply them unless Plus is enabled.
async function applySiteProfileVolumes(origin) {
  const plus = await getPlusSettings();
  if (!plus.entitlement.plusEnabled || !plus.rememberVolumes || !origin) return null;
  const profile = profileForOrigin(plus.siteProfiles, origin);
  if (!profile) return null;
  const volumes = {};
  if (Number.isFinite(profile.originalVolume)) volumes.originalVolume = profile.originalVolume;
  if (Number.isFinite(profile.dubbedVolume)) volumes.dubbedVolume = profile.dubbedVolume;
  return Object.keys(volumes).length ? volumes : null;
}

async function rememberVolumesForActiveSite(kind, value) {
  if (!state.tabOrigin || !sessionVolumes) return;
  const plus = await getPlusSettings();
  if (!plus.entitlement.plusEnabled || !plus.rememberVolumes) return;
  // Preserve the other value from the session's effective volumes, never a
  // stale global setting.
  const originalVolume = kind === 'original' ? value : sessionVolumes.original;
  const dubbedVolume = kind === 'dubbed' ? value : sessionVolumes.dubbed;
  const profiles = upsertProfile(plus.siteProfiles, { origin: state.tabOrigin, originalVolume, dubbedVolume });
  await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_SITE_PROFILES]: profiles });
}

async function persistState() {
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: state });
}

async function setState(patch) {
  state = transitionState(state, patch);
  await persistState();
  chrome.runtime.sendMessage({
    type: 'STATE_CHANGED',
    state: { ...state, sessionVolumes: ACTIVE_STATUSES.has(state.status) ? sessionVolumes : null }
  }).catch(() => undefined);
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'التقاط صوت التبويب وتشغيل الدبلجة العربية أثناء جلسة يبدؤها المستخدم.'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

async function getSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.CONSENT,
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE,
    STORAGE_KEYS.ANALYTICS_CONSENT,
    STORAGE_KEYS.ANALYTICS_DECIDED_AT
  ]);
  const hasLegacyAnalyticsDecision = typeof stored[STORAGE_KEYS.ANALYTICS_CONSENT] === 'boolean';
  const analyticsDecisionRecorded = Boolean(stored[STORAGE_KEYS.ANALYTICS_DECIDED_AT]) || hasLegacyAnalyticsDecision;
  if (hasLegacyAnalyticsDecision && !stored[STORAGE_KEYS.ANALYTICS_DECIDED_AT]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.ANALYTICS_DECIDED_AT]: new Date().toISOString() });
  }
  return {
    hasKey: Boolean(stored[STORAGE_KEYS.API_KEY]),
    hasConsent: Boolean(stored[STORAGE_KEYS.CONSENT]),
    originalVolume: Number.isFinite(stored[STORAGE_KEYS.ORIGINAL_VOLUME])
      ? stored[STORAGE_KEYS.ORIGINAL_VOLUME]
      : DEFAULTS.originalVolume,
    dubbedVolume: Number.isFinite(stored[STORAGE_KEYS.DUBBED_VOLUME])
      ? stored[STORAGE_KEYS.DUBBED_VOLUME]
      : DEFAULTS.dubbedVolume,
    autoDucking: typeof stored[STORAGE_KEYS.AUTO_DUCKING] === 'boolean'
      ? stored[STORAGE_KEYS.AUTO_DUCKING]
      : DEFAULTS.autoDucking,
    uiLanguage: stored[STORAGE_KEYS.UI_LANGUAGE] === 'en' ? 'en' : DEFAULTS.uiLanguage,
    analyticsConsent: stored[STORAGE_KEYS.ANALYTICS_CONSENT] === true,
    analyticsDecisionRecorded
  };
}

async function setAnalyticsConsent(value) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.ANALYTICS_CONSENT]: value === true,
    [STORAGE_KEYS.ANALYTICS_DECIDED_AT]: new Date().toISOString()
  });
}

function safeVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1.5, numeric));
}

async function saveKey(apiKey, consent) {
  const validated = validateKeySave({ apiKey, consent });
  if (!validated.ok) throw new Error(validated.error);
  await chrome.storage.local.set({
    [STORAGE_KEYS.API_KEY]: validated.apiKey,
    [STORAGE_KEYS.CONSENT]: new Date().toISOString()
  });
  await setState({ status: STATUS.READY, message: '' });
}

async function deleteKey() {
  if (ACTIVE_STATUSES.has(state.status)) await stopSession('تم إيقاف الجلسة وحذف المفتاح.');
  await chrome.storage.local.remove([STORAGE_KEYS.API_KEY, STORAGE_KEYS.CONSENT]);
  await setState(publicState({ status: STATUS.NO_KEY, message: 'تم حذف المفتاح من هذا الجهاز.' }));
}

let ignoreCaptureStopUntil = 0;

async function resolveStartTab({ tabId = null, tabUrl = '' } = {}) {
  let tab = null;
  if (tabId) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  // Popup captured this URL with the user gesture. tabs.get in the worker
  // usually omits url without the `tabs` permission, so never prefer an empty tab.url.
  const url = tabUrl || tab?.url || '';
  if (!tab?.id) throw new Error('افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  if (url && !/^https?:/.test(url)) throw new Error('افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  return { id: tab.id, url, origin: originOf(url) || originOf(tabUrl) || tabUrl || null };
}

async function startSession({ tabId = null, tabUrl = '', tabTitle = '', streamId = null } = {}) {
  await initialStateReady;
  if (ACTIVE_STATUSES.has(state.status)) {
    throw new Error('أوقف الدبلجة الحالية قبل بدء التقاط جديد.');
  }

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.CONSENT,
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE
  ]);
  const apiKey = stored[STORAGE_KEYS.API_KEY];
  if (!apiKey || !stored[STORAGE_KEYS.CONSENT]) {
    throw new Error('أدخل مفتاح Gemini أولاً.');
  }

  const probe = await testStoredKey();
  if (probe.result === 'invalid') {
    throw new Error('مفتاح Gemini غير صالح. تحقق منه أو أنشئ مفتاحاً جديداً.');
  }
  if (probe.result === 'unavailable') {
    throw new Error('نموذج الترجمة المباشرة غير متاح لهذا المفتاح أو المنطقة.');
  }

  const tab = await resolveStartTab({ tabId, tabUrl });
  const startedAt = Date.now();
  await setState(publicState({
    status: STATUS.CONNECTING,
    message: 'جارٍ التقاط صوت التبويب والاتصال بـ Gemini…',
    tabId: tab.id,
    tabOrigin: tab.origin,
    startedAt
  }));
  await recordStart(startedAt, tab.origin);
  // Plus drafts start only for entitled users (checked inside the
  // controller). Title/URL are temporary session-storage metadata that move
  // into the permanent record only on explicit save or enabled autosave.
  await plusController.start({
    startedAt,
    siteOrigin: tab.origin,
    title: typeof tabTitle === 'string' ? tabTitle : '',
    pageUrl: tab.url || tabUrl || ''
  }).catch(() => undefined);

  // Opt-in, entitlement-gated per-site profiles override the globals at
  // session start; track them so the popup shows effective volumes and
  // profile updates never clobber one value with a stale global.
  const profileVolumes = await applySiteProfileVolumes(tab.origin);
  const originalVolume = profileVolumes?.originalVolume
    ?? (Number.isFinite(stored[STORAGE_KEYS.ORIGINAL_VOLUME])
      ? stored[STORAGE_KEYS.ORIGINAL_VOLUME]
      : DEFAULTS.originalVolume);
  const dubbedVolume = profileVolumes?.dubbedVolume
    ?? (Number.isFinite(stored[STORAGE_KEYS.DUBBED_VOLUME])
      ? stored[STORAGE_KEYS.DUBBED_VOLUME]
      : DEFAULTS.dubbedVolume);
  sessionVolumes = { original: originalVolume, dubbed: dubbedVolume };

  await ensureOffscreenDocument();
  const mediaStreamId = streamId || await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  ignoreCaptureStopUntil = Date.now() + 2500;
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_SESSION',
    streamId: mediaStreamId,
    apiKey,
    tabId: tab.id,
    originalVolume,
    dubbedVolume,
    autoDucking: typeof stored[STORAGE_KEYS.AUTO_DUCKING] === 'boolean'
      ? stored[STORAGE_KEYS.AUTO_DUCKING]
      : DEFAULTS.autoDucking
  });
  if (!response?.ok) throw new Error(response?.error || 'تعذر بدء معالجة الصوت.');
  return state;
}

async function performStopSession(message) {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) {
      await Promise.race([
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_SESSION' }),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    }
  } finally {
    await closeOffscreenDocument().catch(() => undefined);
    const previousState = state;
    const settings = await getSettings();
    const plus = await getPlusSettings();
    sessionVolumes = null;
    const finalState = publicState({
      status: settings.hasKey && settings.hasConsent ? STATUS.STOPPED : STATUS.NO_KEY,
      message
    });
    await setState(finalState);
    await recordEnd(previousState, false);
    // Idempotent terminal path: updates an explicitly-saved record, autosaves
    // when enabled + entitled, otherwise preserves a bounded unsaved draft.
    await plusController.finish({
      autosave: plus.autosave && plus.entitlement.plusEnabled,
      reason: 'stop'
    }).catch(() => undefined);
  }
  return state;
}

async function stopSession(message = 'تم إيقاف الدبلجة.') {
  if (!stoppingPromise) {
    stoppingPromise = performStopSession(message).finally(() => {
      stoppingPromise = null;
    });
  }
  return stoppingPromise;
}

async function setVolume(kind, value) {
  const volume = safeVolume(value);
  const key = kind === 'original' ? STORAGE_KEYS.ORIGINAL_VOLUME : STORAGE_KEYS.DUBBED_VOLUME;
  await chrome.storage.local.set({ [key]: volume });
  if (ACTIVE_STATUSES.has(state.status)) {
    if (sessionVolumes) {
      sessionVolumes = {
        original: kind === 'original' ? volume : sessionVolumes.original,
        dubbed: kind === 'dubbed' ? volume : sessionVolumes.dubbed
      };
    }
    await rememberVolumesForActiveSite(kind, volume).catch(() => undefined);
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'SET_VOLUME',
      kind,
      value: volume
    }).catch(() => undefined);
  }
  return volume;
}

async function setAutoDucking(enabled) {
  const value = enabled === true;
  await chrome.storage.local.set({ [STORAGE_KEYS.AUTO_DUCKING]: value });
  if (ACTIVE_STATUSES.has(state.status)) {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'SET_AUTO_DUCKING',
      enabled: value
    }).catch(() => undefined);
  }
  return value;
}

async function setUiLanguage(language) {
  const value = language === 'en' ? 'en' : 'ar';
  await chrome.storage.local.set({ [STORAGE_KEYS.UI_LANGUAGE]: value });
  chrome.runtime.sendMessage({ type: 'UI_LANGUAGE_CHANGED', language: value }).catch(() => undefined);
  return value;
}

async function testStoredKey() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.API_KEY, STORAGE_KEYS.CONSENT]);
  if (!stored[STORAGE_KEYS.API_KEY] || !stored[STORAGE_KEYS.CONSENT]) {
    return { result: 'missing' };
  }
  const url = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-live-translate-preview');
  url.searchParams.set('key', stored[STORAGE_KEYS.API_KEY]);
  try {
    const response = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (response.ok) return { result: 'available' };
    if ([401, 403].includes(response.status)) return { result: 'invalid' };
    if (response.status === 404) return { result: 'unavailable' };
    if (response.status === 429) return { result: 'rate_limited' };
    return { result: 'api_error', status: response.status };
  } catch {
    return { result: 'network_error' };
  }
}

async function handleUiMessage(message) {
  if (String(message.type || '').startsWith('PLUS_')) {
    return handlePlusMessage(message);
  }
  switch (message.type) {
    case 'GET_STATE':
      await initialStateReady;
      return {
        ok: true,
        state,
        settings: await getSettings(),
        plus: await getPlusSettings(),
        sessionVolumes: ACTIVE_STATUSES.has(state.status) ? sessionVolumes : null
      };
    case 'GET_STATS':
      await initialStateReady;
      return { ok: true, stats: normalizeUsageStats(usageStats) };
    case 'CLEAR_STATS':
      usageStats = normalizeUsageStats(EMPTY_USAGE_STATS);
      await persistUsageStats();
      return { ok: true, stats: usageStats };
    case 'SAVE_KEY':
      await saveKey(message.apiKey, message.consent);
      return { ok: true, state, settings: await getSettings() };
    case 'DELETE_KEY':
      await deleteKey();
      return { ok: true, state, settings: await getSettings() };
    case 'GET_API_KEY': {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
      return { ok: true, apiKey: stored[STORAGE_KEYS.API_KEY] || '' };
    }
    case 'START_SESSION':
      return { ok: true, state: await startSession({
        tabId: message.tabId,
        tabUrl: message.tabUrl,
        tabTitle: message.tabTitle,
        streamId: message.streamId
      }) };
    case 'START_SESSION_FOR_LAST_TAB':
      if (!state.tabId) throw new Error('لا يوجد تبويب اختبار سابق. ابدأ من نافذة الإضافة أولاً.');
      return { ok: true, state: await startSession({ tabId: state.tabId }) };
    case 'STOP_SESSION':
      return { ok: true, state: await stopSession() };
    case 'SET_VOLUME':
      return { ok: true, value: await setVolume(message.kind, message.value) };
    case 'SET_AUTO_DUCKING':
      return { ok: true, value: await setAutoDucking(message.enabled) };
    case 'SET_UI_LANGUAGE':
      return { ok: true, value: await setUiLanguage(message.language) };
    case 'SET_ANALYTICS_CONSENT':
      await setAnalyticsConsent(message.value);
      return { ok: true, settings: await getSettings() };
    case 'TEST_KEY':
      return { ok: true, ...(await testStoredKey()) };
    case 'GET_FEEDBACK_URL':
      return { ok: true, url: await feedbackPageUrl(message.source || 'popup') };
    default:
      return { ok: false, error: 'طلب غير معروف.' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;
  if (message?.source === 'offscreen') {
    if (message.type === 'OFFSCREEN_STATE') {
      setState({
        ...message.state,
        tabId: state.tabId,
        tabOrigin: state.tabOrigin
      }).catch(() => undefined);
    }
    if (message.type === 'OFFSCREEN_FATAL') {
      setState({
        status: message.status || STATUS.ERROR,
        message: message.message || 'حدث خطأ.',
        diagnosticCode: message.diagnosticCode || null
      })
        .then(() => recordEnd(state, true))
        .then(() => reportRemoteError({
          code: message.diagnosticCode || 'offscreen_fatal',
          message: message.message || 'حدث خطأ.',
          status: message.status || STATUS.ERROR,
          site: state.tabOrigin,
          reconnectCount: state.reconnectCount
        }))
        .then(() => plusController.finish({ reason: 'fatal' }))
        .then(() => closeOffscreenDocument())
        .catch(() => undefined);
    }
    if (message.type === 'CAPTION') {
      if (!message.clear) plusController.caption({
        channel: message.channel,
        text: message.text,
        final: message.final,
        speaker: message.speaker,
        turnId: message.turnId
      });
      const { source: _source, ...caption } = message;
      chrome.runtime.sendMessage(caption).catch(() => undefined);
    }
    return false;
  }

  handleUiMessage(message)
    .then(sendResponse)
    .catch(async (error) => {
      const errorMessage = error?.message || 'حدث خطأ غير متوقع.';
      if (message?.type === 'START_SESSION') {
        await closeOffscreenDocument().catch(() => undefined);
        await setState(publicState({ status: STATUS.ERROR, message: errorMessage }));
        await recordEnd(state, true);
        await reportRemoteError({
          code: 'start_failed',
          message: errorMessage,
          status: STATUS.ERROR,
          site: state.tabOrigin
        });
        sessionVolumes = null;
        await plusController.finish({ reason: 'start_failure' }).catch(() => undefined);
      }
      sendResponse({ ok: false, error: errorMessage, state });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.tabId === tabId && ACTIVE_STATUSES.has(state.status)) {
    stopSession('أُغلِق التبويب الذي كانت تتم دبلجته.').catch(() => undefined);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!ACTIVE_STATUSES.has(state.status) || tabId !== state.tabId || !state.tabOrigin) return;
  const nextOrigin = originOf(changeInfo.url || tab?.url);
  if (nextOrigin && nextOrigin !== state.tabOrigin) {
    stopSession('تغير الموقع. ابدأ الدبلجة مجدداً لالتقاط الصوت.').catch(() => undefined);
  }
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (Date.now() < ignoreCaptureStopUntil) return;
  if (info.tabId !== state.tabId || !['stopped', 'error'].includes(info.status)) return;
  clearTimeout(captureStatusTimer);
  captureStatusTimer = setTimeout(() => {
    captureStatusTimer = null;
    if (info.tabId === state.tabId && ACTIVE_STATUSES.has(state.status)) {
      stopSession(info.status === 'error'
        ? 'فشل التقاط صوت التبويب.'
        : 'انتهى مسار صوت التبويب بشكل غير متوقع.')
        .catch(() => undefined);
    }
  }, 750);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});
