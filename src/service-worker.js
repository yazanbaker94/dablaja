import {
  ACTIVE_STATUSES,
  DEFAULTS,
  SESSION_STORAGE_KEYS,
  SESSION_STATE_KEY,
  STATUS,
  STORAGE_KEYS,
  originOf,
  publicState
} from './shared/constants.js';
import { transitionState } from './shared/lifecycle.js';
import { EMPTY_USAGE_STATS, normalizeUsageStats, recordSessionEnd, recordSessionStart } from './shared/usage-stats.js';
import { validateApiKey } from './shared/key-validation.js';
import { createLibraryDraftController } from './shared/library-draft-controller.js';
import { createLibraryMessageHandler } from './shared/library-messages.js';
import {
  clearSavedSessions,
  countSavedSessions,
  deleteSavedSession,
  getSavedSession,
  listSavedSessions,
  putSavedSession,
  putSavedSessionBatch
} from './shared/library-db.js';
import { normalizeProfileOrigin, profileForOrigin, removeProfile, upsertProfile } from './shared/site-profiles.js';
import { LIBRARY_LIMITS, validateSessionRecord } from './shared/library-session.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let state = publicState();
let creatingOffscreen = null;
let startingPromise = null;
let stoppingPromise = null;
let captureStatusTimer = null;
let usageStats = normalizeUsageStats(EMPTY_USAGE_STATS);
let trackedSession = null;

const OBSOLETE_STORAGE_KEYS = [
  'privacyConsentAt',
  'privacyConsentVersion',
  'anonymousUsageDecisionAt',
  'plusLocalLibraryDecidedAt',
  'plusAutosave',
  // Left behind by the retired licensing and opt-in telemetry features.
  'installId',
  'anonymousUsageConsent',
  'plusLicense',
  'plusInstallCredential'
];

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

async function recordStart(startedAt, site = null, diagnosticSessionId = '') {
  usageStats = recordSessionStart(usageStats, startedAt, { site });
  trackedSession = { startedAt: startedAt || Date.now(), site: site || null, diagnosticSessionId };
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
}

async function loadInitialState() {
  await loadUsageStats();
  const tracked = await chrome.storage.session.get(TRACKED_SESSION_KEY);
  trackedSession = tracked[TRACKED_SESSION_KEY] || null;
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE
  ]);
  await chrome.storage.local.remove(OBSOLETE_STORAGE_KEYS).catch(() => undefined);
  const previous = await chrome.storage.session.get(SESSION_STATE_KEY);
  const previousState = previous[SESSION_STATE_KEY];
  const wasActive = ACTIVE_STATUSES.has(previousState?.status);
  // A persisted recovery snapshot can only belong to a session from before
  // this worker restarted. Finalize it into the real local library.
  await libraryController.restore().catch(() => undefined);
  await migrateLegacyUnsavedSessions().catch(() => undefined);
  if (trackedSession) {
    await recordEnd(
      previousState || { tabOrigin: trackedSession.site },
      previousState?.status === STATUS.ERROR
    );
  }
  state = publicState({
    status: stored[STORAGE_KEYS.API_KEY] ? (wasActive ? STATUS.STOPPED : STATUS.READY) : STATUS.NO_KEY,
    message: wasActive ? 'توقفت الجلسة بعد إعادة تحميل الإضافة.' : ''
  });
  await persistState();
}

// ---------------------------------------------------------------------------
// Local session library and recovery.
// The active recovery snapshot lives in chrome.storage.session (survives
// service-worker suspension, cleared when the browser closes). Completed
// sessions live in IndexedDB. Transcript content never leaves the device
// and is never logged.
// Recovery lifecycle, persistence races and byte budgets are owned by the
// adapter-injected controller; library requests are validated centrally in
// createLibraryMessageHandler — UI disabled states are never trusted.
// ---------------------------------------------------------------------------

const recoveryStorageAdapter = {
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

const sessionStoreAdapter = {
  get: (id) => getSavedSession(id),
  list: () => listSavedSessions(),
  count: () => countSavedSessions(),
  put: (record) => putSavedSession(record),
  delete: (id) => deleteSavedSession(id),
  clear: () => clearSavedSessions(),
  putBatch: (records) => putSavedSessionBatch(records)
};

const librarySettingsAdapter = {
  get: () => getLibrarySettings(),
  async setRemember(value) {
    const enabled = value === true;
    await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_REMEMBER_VOLUMES]: enabled });
    // If enabled during a running session, capture both effective levels
    // immediately. The user should not have to move a slider again merely to
    // create the first per-site profile.
    if (enabled && state.tabOrigin && sessionVolumes) {
      const current = await getLibrarySettings();
      const maxProfiles = LIBRARY_LIMITS.MAX_SITE_PROFILES;
      const profiles = upsertProfile(current.siteProfiles, {
        origin: state.tabOrigin,
        originalVolume: sessionVolumes.original,
        dubbedVolume: sessionVolumes.dubbed
      }, maxProfiles);
      await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_SITE_PROFILES]: profiles });
    }
    return getLibrarySettings();
  },
  async deleteProfile(origin) {
    const librarySettings = await getLibrarySettings();
    const profiles = removeProfile(librarySettings.siteProfiles, origin);
    await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_SITE_PROFILES]: profiles });
    if (ACTIVE_STATUSES.has(state.status) && state.tabOrigin === origin) {
      const settings = await getSettings();
      if (sessionVolumes) {
        sessionVolumes.original = settings.originalVolume;
        sessionVolumes.dubbed = settings.dubbedVolume;
      }
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'SET_VOLUME',
        kind: 'original',
        value: settings.originalVolume
      }).catch(() => undefined);
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'SET_VOLUME',
        kind: 'dubbed',
        value: settings.dubbedVolume
      }).catch(() => undefined);
      await setState({ ...state });
    }
    return { ...librarySettings, siteProfiles: profiles };
  },
  async updateProfile(origin, { originalVolume, dubbedVolume } = {}) {
    const librarySettings = await getLibrarySettings();
    const normalizedOrigin = normalizeProfileOrigin(origin);
    const maxProfiles = LIBRARY_LIMITS.MAX_SITE_PROFILES;
    const exists = librarySettings.siteProfiles.some((profile) => profile.origin === normalizedOrigin);
    if (normalizedOrigin && !exists && librarySettings.siteProfiles.length >= maxProfiles) {
      const error = new Error('وصلت إلى الحد الأقصى لملفات المواقع (50).');
      error.code = 'site_profile_limit';
      throw error;
    }
    // Null values preserve the stored level, so editing one slider never
    // clobbers the other.
    const profiles = upsertProfile(
      librarySettings.siteProfiles,
      { origin: normalizedOrigin, originalVolume, dubbedVolume },
      maxProfiles
    );
    await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_SITE_PROFILES]: profiles });
    if (ACTIVE_STATUSES.has(state.status) && state.tabOrigin === origin) {
      const activeProfile = profileForOrigin(profiles, origin);
      if (activeProfile) {
        if (originalVolume != null && Number.isFinite(activeProfile.originalVolume)) {
          if (sessionVolumes) sessionVolumes.original = activeProfile.originalVolume;
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'SET_VOLUME',
            kind: 'original',
            value: activeProfile.originalVolume
          }).catch(() => undefined);
        }
        if (dubbedVolume != null && Number.isFinite(activeProfile.dubbedVolume)) {
          if (sessionVolumes) sessionVolumes.dubbed = activeProfile.dubbedVolume;
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'SET_VOLUME',
            kind: 'dubbed',
            value: activeProfile.dubbedVolume
          }).catch(() => undefined);
        }
        await setState({ ...state });
      }
    }
    return { ...librarySettings, siteProfiles: profiles };
  }
};

const libraryController = createLibraryDraftController({
  storage: recoveryStorageAdapter,
  db: {
    putSession: (record, options) => putSavedSession(record, options),
    getSession: (id) => getSavedSession(id),
    list: () => listSavedSessions()
  }
});

// Older preview builds exposed later Free sessions as "drafts". Migrate any
// such records into the real library once, then remove that obsolete queue.
async function migrateLegacyUnsavedSessions() {
  const key = SESSION_STORAGE_KEYS.LIBRARY_UNSAVED_DRAFTS;
  const stored = await chrome.storage.session.get(key);
  const records = Array.isArray(stored[key]) ? stored[key] : [];
  if (!records.length) {
    await chrome.storage.session.remove(key).catch(() => undefined);
    return;
  }
  const failed = [];
  for (const raw of records) {
    const record = validateSessionRecord(raw);
    if (!record) continue;
    try {
      await putSavedSession(record);
    } catch {
      failed.push(record);
    }
  }
  if (failed.length) await chrome.storage.session.set({ [key]: failed });
  else await chrome.storage.session.remove(key);
}

libraryController.subscribe((event) => {
  chrome.runtime.sendMessage(event).catch(() => undefined);
});

const handleLibraryMessage = createLibraryMessageHandler({
  controller: libraryController,
  library: sessionStoreAdapter,
  settings: librarySettingsAdapter
});

// Start asynchronous restoration only after every dependency used by
// loadInitialState() has been initialized. This avoids relying on the first
// storage await to defer access to libraryController past its declaration.
const initialStateReady = loadInitialState().catch(() => undefined);

// Effective volumes for the ACTIVE session (site-profile values when a
// profile applied). Popup sliders display these; profile updates preserve
// the other value from here instead of a stale global.
let sessionVolumes = null;

async function getLibrarySettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.LIBRARY_REMEMBER_VOLUMES,
    STORAGE_KEYS.LIBRARY_SITE_PROFILES,
    STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED
  ]);
  return {
    rememberVolumes: stored[STORAGE_KEYS.LIBRARY_REMEMBER_VOLUMES] === true,
    // Local session saving defaults ON; an explicit false keeps recovery
    // snapshots and completed transcript records out of storage.
    localSavingEnabled: stored[STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED] !== false,
    siteProfiles: Array.isArray(stored[STORAGE_KEYS.LIBRARY_SITE_PROFILES])
      ? stored[STORAGE_KEYS.LIBRARY_SITE_PROFILES]
      : []
  };
}

async function setLocalSavingEnabled(value) {
  if (typeof value !== 'boolean') throw new Error('إعداد الحفظ المحلي غير صالح.');
  await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED]: value });
  // If enabled while a dubbing session is already active, start recovery
  // capture from now.
  if (value === true && ACTIVE_STATUSES.has(state.status) && state.tabOrigin) {
    const hasActive = libraryController.status().active;
    if (!hasActive) {
      await libraryController.start({
        startedAt: state.startedAt || Date.now(),
        siteOrigin: state.tabOrigin,
        title: '',
        pageUrl: ''
      }).catch(() => undefined);
    }
  }
  // If disabled mid-session, stop persistence immediately and delete the
  // temporary recovery snapshot. Live dubbing continues in memory.
  if (value === false) {
    await libraryController.finish({ autosave: false, reason: 'local_saving_disabled' }).catch(() => undefined);
    await chrome.storage.session.remove(SESSION_STORAGE_KEYS.LIBRARY_ACTIVE_DRAFT).catch(() => undefined);
  }
  return getLibrarySettings();
}

async function applySiteProfileVolumes(origin) {
  const librarySettings = await getLibrarySettings();
  if (!librarySettings.rememberVolumes || !origin) return null;
  const profile = profileForOrigin(librarySettings.siteProfiles, origin);
  if (!profile) return null;
  const volumes = {};
  if (Number.isFinite(profile.originalVolume)) volumes.originalVolume = profile.originalVolume;
  if (Number.isFinite(profile.dubbedVolume)) volumes.dubbedVolume = profile.dubbedVolume;
  return Object.keys(volumes).length ? volumes : null;
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
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE
  ]);
  return {
    hasKey: Boolean(stored[STORAGE_KEYS.API_KEY]),
    originalVolume: Number.isFinite(stored[STORAGE_KEYS.ORIGINAL_VOLUME])
      ? stored[STORAGE_KEYS.ORIGINAL_VOLUME]
      : DEFAULTS.originalVolume,
    dubbedVolume: Number.isFinite(stored[STORAGE_KEYS.DUBBED_VOLUME])
      ? stored[STORAGE_KEYS.DUBBED_VOLUME]
      : DEFAULTS.dubbedVolume,
    autoDucking: typeof stored[STORAGE_KEYS.AUTO_DUCKING] === 'boolean'
      ? stored[STORAGE_KEYS.AUTO_DUCKING]
      : DEFAULTS.autoDucking,
    uiLanguage: stored[STORAGE_KEYS.UI_LANGUAGE] === 'en' ? 'en' : DEFAULTS.uiLanguage
  };
}

function safeVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1.5, numeric));
}

async function saveKey(apiKey) {
  const validated = validateApiKey(apiKey);
  if (!validated.ok) throw new Error(validated.error);
  if (ACTIVE_STATUSES.has(state.status)) {
    throw new Error('أوقف الدبلجة الحالية قبل تغيير المفتاح.');
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: validated.apiKey });
  await setState({ status: STATUS.READY, message: '' });
}

async function deleteKey() {
  if (ACTIVE_STATUSES.has(state.status)) await stopSession('تم إيقاف الجلسة وحذف المفتاح.');
  await chrome.storage.local.remove(STORAGE_KEYS.API_KEY);
  await setState(publicState({ status: STATUS.NO_KEY, message: 'تم حذف المفتاح من هذا الجهاز.' }));
}

let ignoreCaptureStopUntil = 0;

async function resolveStartTab({ tabId = null, tabUrl = '', tabTitle = '' } = {}) {
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
  const title = tabTitle || tab?.title || '';
  if (!tab?.id) throw new Error('افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  if (url && !/^https?:/.test(url)) throw new Error('افتح صفحة ويب عادية تحتوي على صوت ثم حاول مجدداً.');
  return { id: tab.id, url, origin: originOf(url) || originOf(tabUrl) || tabUrl || null, title };
}

async function performStartSessionCore({ tabId = null, tabUrl = '', tabTitle = '', streamId = null } = {}, diagnostics) {
  await initialStateReady;
  if (ACTIVE_STATUSES.has(state.status)) {
    const error = new Error('أوقف الدبلجة الحالية قبل بدء التقاط جديد.');
    error.code = 'session_already_active';
    throw error;
  }

  diagnostics.failureStage = 'storage';
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE
  ]);
  const apiKey = stored[STORAGE_KEYS.API_KEY];
  if (!apiKey) {
    throw new Error('أدخل مفتاح Gemini أولاً.');
  }

  diagnostics.failureStage = 'key_probe';
  const probe = await testStoredKey();
  if (probe.result === 'invalid') {
    throw new Error('مفتاح Gemini غير صالح. تحقق منه أو أنشئ مفتاحاً جديداً.');
  }
  if (probe.result === 'unavailable') {
    throw new Error('نموذج الترجمة المباشرة غير متاح لهذا المفتاح أو المنطقة.');
  }

  diagnostics.failureStage = 'tab_resolution';
  const tab = await resolveStartTab({ tabId, tabUrl, tabTitle });
  const startedAt = Date.now();
  // Resolve effective volumes BEFORE the first state broadcast so every
  // STATE_CHANGED/GET_STATE from here on carries the profile values, not
  // a null that makes the UI fall back to the stale globals.
  // Opt-in per-site profiles override the globals at session start; track them so the popup shows effective volumes and
  // profile updates never clobber one value with a stale global.
  diagnostics.failureStage = 'site_profile';
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
  await setState(publicState({
    status: STATUS.CONNECTING,
    message: 'جارٍ التقاط صوت التبويب والاتصال بـ Gemini…',
    tabId: tab.id,
    tabOrigin: tab.origin,
    startedAt
  }));
  await recordStart(startedAt, tab.origin, diagnostics.sessionId);
  // Starting dubbing creates only a bounded recovery snapshot. Completed
  // sessions become real local library records.
  diagnostics.failureStage = 'local_session';
  const localSaving = await chrome.storage.local.get(STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED);
  const localSavingEnabled = localSaving[STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED] !== false;
  if (localSavingEnabled) {
    // The recovery snapshot is internal and never appears as a separate draft
    // product or placeholder card in the library.
    await libraryController.start({
      startedAt,
      siteOrigin: tab.origin,
      title: tab.title || tabTitle || '',
      pageUrl: tab.url || tabUrl || ''
    }).catch(() => undefined);
  }

  diagnostics.failureStage = 'offscreen_document';
  await ensureOffscreenDocument();
  diagnostics.failureStage = 'tab_capture';
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
      : DEFAULTS.autoDucking,
    diagnosticSessionId: diagnostics.sessionId
  });
  if (!response?.ok) {
    const error = new Error(response?.error || 'تعذر بدء معالجة الصوت.');
    error.diagnostics = response?.diagnostics || { ...diagnostics, failureStage: 'tab_stream' };
    throw error;
  }
  return state;
}

async function performStartSession(options = {}) {
  const diagnostics = {
    sessionId: crypto.randomUUID(),
    failureStage: 'initialization',
    protocolSource: 'client',
    networkOnline: navigator.onLine !== false
  };
  try {
    return await performStartSessionCore(options, diagnostics);
  } catch (error) {
    if (!error.diagnostics) error.diagnostics = { ...diagnostics };
    throw error;
  }
}

async function startSession(options = {}) {
  if (stoppingPromise) await stoppingPromise;
  if (!startingPromise) {
    startingPromise = performStartSession(options).finally(() => {
      startingPromise = null;
    });
  }
  return startingPromise;
}

async function performStopSession(message) {
  let saved = false;
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
    sessionVolumes = null;
    const finalState = publicState({
      status: settings.hasKey ? STATUS.STOPPED : STATUS.NO_KEY,
      message,
      // Keep the last tab reference so diagnostics "retry previous tab"
      // remains usable after a stop.
      tabId: previousState?.tabId ?? null,
      tabOrigin: previousState?.tabOrigin ?? null
    });
    await setState(finalState);
    await recordEnd(previousState, false);
    // Every completed session becomes a real local library record.
    // A storage failure keeps the internal recovery snapshot.
    try {
      const draftStatus = libraryController.status().active;
      if (draftStatus && (draftStatus.lineCount > 0 || draftStatus.bookmarkCount > 0)) {
        await libraryController.saveActive().catch(() => undefined);
      }
      const finishResult = await libraryController.finish({
        autosave: true,
        reason: 'stop'
      });
      if (finishResult && typeof finishResult.id === 'string') {
        saved = true;
      }
    } catch {}
  }
  return { state, saved };
}

async function stopSession(message = 'تم إيقاف الدبلجة.') {
  // A Stop issued while tab capture/offscreen startup is still pending must
  // not finish before that startup creates its resources. Await the shared
  // start window, then dispose the resulting session exactly once.
  if (startingPromise) await startingPromise.catch(() => undefined);
  if (!stoppingPromise) {
    stoppingPromise = performStopSession(message).finally(() => {
      stoppingPromise = null;
    });
  }
  return stoppingPromise;
}

async function setVolume(kind, value, origin = null) {
  const volume = safeVolume(value);
  const key = kind === 'original' ? STORAGE_KEYS.ORIGINAL_VOLUME : STORAGE_KEYS.DUBBED_VOLUME;
  const targetOrigin = origin || (ACTIVE_STATUSES.has(state.status) ? state.tabOrigin : null);

  if (ACTIVE_STATUSES.has(state.status)) {
    if (sessionVolumes) {
      sessionVolumes = {
        original: kind === 'original' ? volume : sessionVolumes.original,
        dubbed: kind === 'dubbed' ? volume : sessionVolumes.dubbed
      };
    }
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'SET_VOLUME',
      kind,
      value: volume
    }).catch(() => undefined);
  }

  const librarySettings = await getLibrarySettings();
  const maxProfiles = LIBRARY_LIMITS.MAX_SITE_PROFILES;

  if (librarySettings.rememberVolumes && targetOrigin) {
    const profile = profileForOrigin(librarySettings.siteProfiles, targetOrigin);
    const stored = await chrome.storage.local.get([STORAGE_KEYS.ORIGINAL_VOLUME, STORAGE_KEYS.DUBBED_VOLUME]);
    const defaultOrig = Number.isFinite(stored[STORAGE_KEYS.ORIGINAL_VOLUME]) ? stored[STORAGE_KEYS.ORIGINAL_VOLUME] : 0.25;
    const defaultDub = Number.isFinite(stored[STORAGE_KEYS.DUBBED_VOLUME]) ? stored[STORAGE_KEYS.DUBBED_VOLUME] : 1.0;
    const originalVolume = kind === 'original' ? volume : (profile?.originalVolume ?? sessionVolumes?.original ?? defaultOrig);
    const dubbedVolume = kind === 'dubbed' ? volume : (profile?.dubbedVolume ?? sessionVolumes?.dubbed ?? defaultDub);
    const profiles = upsertProfile(librarySettings.siteProfiles, { origin: targetOrigin, originalVolume, dubbedVolume }, maxProfiles);
    await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_SITE_PROFILES]: profiles });
    return { volume, librarySettings: { ...librarySettings, siteProfiles: profiles } };
  } else {
    await chrome.storage.local.set({ [key]: volume });
    return { volume, librarySettings };
  }
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
  const stored = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  if (!stored[STORAGE_KEYS.API_KEY]) {
    return { result: 'missing' };
  }
  const url = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-live-translate-preview');
  url.searchParams.set('key', stored[STORAGE_KEYS.API_KEY]);
  try {
    const response = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (response.ok) return { result: 'available' };
    // Google answers malformed/unknown keys with 400 API_KEY_INVALID;
    // 401/403 cover permission-revoked keys.
    if ([400, 401, 403].includes(response.status)) return { result: 'invalid' };
    if (response.status === 404) return { result: 'unavailable' };
    if (response.status === 429) return { result: 'rate_limited' };
    return { result: 'api_error', status: response.status };
  } catch {
    return { result: 'network_error' };
  }
}

// The local-saving switch touches the active session, so it is handled here
// in the worker. Its name starts with LIBRARY_, so without this explicit set
// the generic LIBRARY_* delegation below would swallow it.
const WORKER_HANDLED_LIBRARY_TYPES = new Set(['LIBRARY_SET_LOCAL_SAVING', 'LIBRARY_GET_LOCAL_SAVING']);

async function handleUiMessage(message) {
  // Every UI route shares the same restored settings/session baseline.
  // Without this barrier, a fast popup click during an MV3 worker wake could
  // race recovery restoration or overwrite freshly loaded state.
  await initialStateReady;
  if (WORKER_HANDLED_LIBRARY_TYPES.has(message.type)) {
    switch (message.type) {
      case 'LIBRARY_SET_LOCAL_SAVING':
        return { ok: true, librarySettings: await setLocalSavingEnabled(message.value) };
      case 'LIBRARY_GET_LOCAL_SAVING':
        return { ok: true, librarySettings: await getLibrarySettings() };
    }
  }
  if (String(message.type || '').startsWith('LIBRARY_')) {
    return handleLibraryMessage(message);
  }
  switch (message.type) {
    case 'GET_STATE':
      return {
        ok: true,
        // Same enriched shape as STATE_CHANGED broadcasts: consumers read
        // response.state, so the effective volumes must live inside it.
        state: { ...state, sessionVolumes: ACTIVE_STATUSES.has(state.status) ? sessionVolumes : null },
        settings: await getSettings(),
        librarySettings: await getLibrarySettings()
      };
    case 'GET_STATS':
      return { ok: true, stats: normalizeUsageStats(usageStats) };
    case 'CLEAR_STATS':
      usageStats = normalizeUsageStats(EMPTY_USAGE_STATS);
      await persistUsageStats();
      return { ok: true, stats: usageStats };
    case 'SAVE_KEY':
      await saveKey(message.apiKey);
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
    case 'STOP_SESSION': {
      const result = await stopSession();
      // result is { state, saved } from performStopSession
      if (result && typeof result.state !== 'undefined') {
        return { ok: true, state: result.state, saved: Boolean(result.saved) };
      }
      return { ok: true, state: result };
    }
    case 'SET_VOLUME': {
      const result = await setVolume(message.kind, message.value, message.origin);
      return {
        ok: true,
        value: result.volume,
        librarySettings: result.librarySettings
      };
    }
    case 'SET_AUTO_DUCKING':
      return { ok: true, value: await setAutoDucking(message.enabled) };
    case 'SET_UI_LANGUAGE':
      return { ok: true, value: await setUiLanguage(message.language) };
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
        .then(() => libraryController.finish({ autosave: true, reason: 'fatal' }))
        .then(() => closeOffscreenDocument())
        .catch(() => undefined);
    }
    if (message.type === 'CAPTION') {
      if (!message.clear) libraryController.caption({
        channel: message.channel,
        text: message.text,
        final: message.final,
        speaker: message.speaker,
        turnId: message.turnId
      });
      const caption = { ...message };
      delete caption.source;
      chrome.runtime.sendMessage(caption).catch(() => undefined);
    }
    return false;
  }

  handleUiMessage(message)
    .then(sendResponse)
    .catch(async (error) => {
      const errorMessage = error?.message || 'حدث خطأ غير متوقع.';
      if (['START_SESSION', 'START_SESSION_FOR_LAST_TAB'].includes(message?.type)
        && error?.code !== 'session_already_active') {
        const failedStartState = state;
        await closeOffscreenDocument().catch(() => undefined);
        await setState(publicState({ status: STATUS.ERROR, message: errorMessage }));
        await recordEnd(failedStartState, true);
        sessionVolumes = null;
        await libraryController.finish({ autosave: true, reason: 'start_failure' }).catch(() => undefined);
      }
      sendResponse({
        ok: false,
        error: errorMessage,
        code: error?.code || undefined,
        state
      });
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
  captureStatusTimer = setTimeout(async () => {
    captureStatusTimer = null;
    if (info.tabId !== state.tabId || !ACTIVE_STATUSES.has(state.status)) return;

    // Chrome can deliver a delayed `stopped` notification for a capture that
    // was just replaced on the same tab. Re-check the tab's current capture
    // state before allowing that stale event to tear down the new session.
    let captures;
    try {
      captures = await chrome.tabCapture.getCapturedTabs();
    } catch {
      // The offscreen track/socket lifecycle still performs authoritative
      // cleanup. Failing open here avoids killing healthy audio solely because
      // this diagnostic query was unavailable during worker wake-up.
      return;
    }
    const current = captures.find((capture) => capture.tabId === info.tabId);
    if (current && !['stopped', 'error'].includes(current.status)) return;
    if (info.tabId !== state.tabId || !ACTIVE_STATUSES.has(state.status)) return;

    stopSession(info.status === 'error'
      ? 'فشل التقاط صوت التبويب.'
      : 'انتهى مسار صوت التبويب بشكل غير متوقع.')
      .catch(() => undefined);
  }, 750);
});
