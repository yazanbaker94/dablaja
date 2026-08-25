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
import { configureUninstallUrl, feedbackPageUrl, reportRemoteError, reportUsageSession, ensureInstallIdentity } from './shared/telemetry.js';
import { validateApiKey } from './shared/key-validation.js';
import { resolveEntitlement, LICENSE_STATUS_URL, LICENSE_TOKEN_URL, RECOVER_LICENSE_URL, ROTATE_RECOVERY_URL } from './shared/plus-entitlement.js';
import { createLicenseRefreshCoordinator, REFRESH_ALARM_NAME } from './shared/license-refresh-coordinator.js';
import { normalizeStripeCheckoutUrl } from './shared/checkout-url.js';
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
import { normalizeProfileOrigin, profileForOrigin, removeProfile, upsertProfile } from './shared/site-profiles.js';

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
  'plusAutosave'
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
    STORAGE_KEYS.ORIGINAL_VOLUME,
    STORAGE_KEYS.DUBBED_VOLUME,
    STORAGE_KEYS.AUTO_DUCKING,
    STORAGE_KEYS.UI_LANGUAGE,
    STORAGE_KEYS.ANALYTICS_CONSENT
  ]);
  await chrome.storage.local.remove(OBSOLETE_STORAGE_KEYS).catch(() => undefined);
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
    status: stored[STORAGE_KEYS.API_KEY] ? (wasActive ? STATUS.STOPPED : STATUS.READY) : STATUS.NO_KEY,
    message: wasActive ? 'توقفت الجلسة بعد إعادة تحميل الإضافة.' : ''
  });
  await persistState();
  await configureUninstallUrl().catch(() => undefined);
}

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
  async setLicense(record) {
    if (record) {
      await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_LICENSE]: record });
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.PLUS_LICENSE);
    }
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
    return { ...plus, siteProfiles: profiles };
  },
  async updateProfile(origin, { originalVolume, dubbedVolume } = {}) {
    const plus = await getPlusSettings();
    // Null values preserve the stored level, so editing one slider never
    // clobbers the other.
    const profiles = upsertProfile(plus.siteProfiles, { origin, originalVolume, dubbedVolume });
    await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_SITE_PROFILES]: profiles });
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
    return { ...plus, siteProfiles: profiles };
  }
};

const plusController = createPlusDraftController({
  storage: plusStorageAdapter,
  db: {
    putSession: (record, options) => putSavedSession(record, options),
    getSession: (id) => getSavedSession(id),
    list: () => listSavedSessions()
  },
  getEntitlement: async () => (await getPlusSettings()).entitlement,
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
  // the library UI.
  entitlement: () => getPlusSettings(),
  getExpectedInstallId: async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.INSTALL_ID);
    const id = stored[STORAGE_KEYS.INSTALL_ID];
    return typeof id === 'string' && id.length >= 16 ? id : null;
  }
});

// Start asynchronous restoration only after every dependency used by
// loadInitialState() has been initialized. This avoids relying on the first
// storage await to defer access to plusController past its declaration.
const initialStateReady = loadInitialState().catch(() => undefined);

// Effective volumes for the ACTIVE session (site-profile values when a
// profile applied). Popup sliders display these; profile updates preserve
// the other value from here instead of a stale global.
let sessionVolumes = null;

async function getPlusSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.PLUS_LICENSE,
    STORAGE_KEYS.PLUS_REMEMBER_VOLUMES,
    STORAGE_KEYS.PLUS_SITE_PROFILES,
    STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED,
    STORAGE_KEYS.INSTALL_ID
  ]);
  const currentInstallId = typeof stored[STORAGE_KEYS.INSTALL_ID] === 'string' ? stored[STORAGE_KEYS.INSTALL_ID] : null;
  return {
    // A plain local { state: 'active' } record is NOT verifiable evidence;
    // only the signed-license verifier pipeline can unlock Plus in production.
    // Missing or malformed data defaults to locked.
    entitlement: await resolveEntitlement({ licenseRecord: stored[STORAGE_KEYS.PLUS_LICENSE], expectedInstallId: currentInstallId, nowMs: Date.now() }),
    rememberVolumes: stored[STORAGE_KEYS.PLUS_REMEMBER_VOLUMES] === true,
    // Local session saving defaults ON (opt-out via the Plus settings toggle);
    // only an explicit false keeps drafts out of storage.
    localSavingEnabled: stored[STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED] !== false,
    siteProfiles: Array.isArray(stored[STORAGE_KEYS.PLUS_SITE_PROFILES])
      ? stored[STORAGE_KEYS.PLUS_SITE_PROFILES]
      : []
  };
}

async function setLocalSavingEnabled(value) {
  if (typeof value !== 'boolean') throw new Error('إعداد الحفظ المحلي غير صالح.');
  await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED]: value });
  // If enabled while a dubbing session is already active, start draft capture from now.
  if (value === true && ACTIVE_STATUSES.has(state.status) && state.tabOrigin) {
    const hasActive = plusController.status().active;
    if (!hasActive) {
      const plusNow = await getPlusSettings();
      const savedSessions = plusNow.entitlement.plusEnabled ? [] : await listSavedSessions();
      if (plusNow.entitlement.plusEnabled || savedSessions.length < 1) {
        await plusController.start({
          startedAt: state.startedAt || Date.now(),
          siteOrigin: state.tabOrigin,
          title: '',
          pageUrl: ''
        }).catch(() => undefined);
      }
    }
  }
  // If disabled mid-session: stop persistence immediately. The active
  // draft is finalized WITHOUT autosave into the unsaved list so the user
  // can explicitly Save or Discard it; live dubbing/captions continue in
  // memory, and future CAPTION events must not be written to storage.
  if (value === false) {
    await plusController.finish({ autosave: false, reason: 'local_saving_disabled' }).catch(() => undefined);
  }
  return getPlusSettings();
}

async function applySiteProfileVolumes(origin) {
  const plus = await getPlusSettings();
  if (!plus.rememberVolumes || !origin) return null;
  const profile = profileForOrigin(plus.siteProfiles, origin);
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
    STORAGE_KEYS.UI_LANGUAGE,
    STORAGE_KEYS.ANALYTICS_CONSENT
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
    uiLanguage: stored[STORAGE_KEYS.UI_LANGUAGE] === 'en' ? 'en' : DEFAULTS.uiLanguage,
    // Optional telemetry is strictly opt-in. A store disclosure alone is not
    // an affirmative consent action.
    analyticsConsent: stored[STORAGE_KEYS.ANALYTICS_CONSENT] === true
  };
}

async function setAnalyticsConsent(value) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ANALYTICS_CONSENT]: value === true });
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

async function performStartSession({ tabId = null, tabUrl = '', tabTitle = '', streamId = null } = {}) {
  await initialStateReady;
  if (ACTIVE_STATUSES.has(state.status)) {
    const error = new Error('أوقف الدبلجة الحالية قبل بدء التقاط جديد.');
    error.code = 'session_already_active';
    throw error;
  }

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

  const probe = await testStoredKey();
  if (probe.result === 'invalid') {
    throw new Error('مفتاح Gemini غير صالح. تحقق منه أو أنشئ مفتاحاً جديداً.');
  }
  if (probe.result === 'unavailable') {
    throw new Error('نموذج الترجمة المباشرة غير متاح لهذا المفتاح أو المنطقة.');
  }

  const tab = await resolveStartTab({ tabId, tabUrl, tabTitle });
  const startedAt = Date.now();
  // Resolve effective volumes BEFORE the first state broadcast so every
  // STATE_CHANGED/GET_STATE from here on carries the profile values, not
  // a null that makes the UI fall back to the stale globals.
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
  await setState(publicState({
    status: STATUS.CONNECTING,
    message: 'جارٍ التقاط صوت التبويب والاتصال بـ Gemini…',
    tabId: tab.id,
    tabOrigin: tab.origin,
    startedAt
  }));
  await recordStart(startedAt, tab.origin);
  // Explicit-save semantics: starting dubbing never permanently saves.
  // The local-saving setting defaults on and can be disabled at any time. When
  // disabled, captions remain memory-only and page metadata is not written to
  // session storage; live dubbing is never blocked.
  const localSaving = await chrome.storage.local.get(STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED);
  const localSavingEnabled = localSaving[STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED] !== false;
  if (localSavingEnabled) {
    const plusNow = await getPlusSettings();
    const savedSessions = plusNow.entitlement.plusEnabled ? [] : await listSavedSessions();
    // Capture a local draft for Plus, or for the one free-plan slot. Once the
    // free slot is used, later dubbing remains live/memory-only until the user
    // deletes that session or upgrades—no hidden transcript is accumulated.
    if (plusNow.entitlement.plusEnabled || savedSessions.length < 1) {
      await plusController.start({
        startedAt,
        siteOrigin: tab.origin,
        title: tab.title || tabTitle || '',
        pageUrl: tab.url || tabUrl || ''
      }).catch(() => undefined);
    }
  }

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
    // Plus auto-saves on stop. The free tier auto-saves its one included session;
    // once that slot exists, later sessions were never drafted. A storage
    // failure keeps a bounded recoverable draft. Never show a saved animation
    // unless IndexedDB confirmed the write.
    try {
      const draftStatus = plusController.status().active;
      const plusNow = await getPlusSettings();
      if (draftStatus
        && !plusNow.entitlement.plusEnabled
        && (draftStatus.lineCount > 0 || draftStatus.bookmarkCount > 0)) {
        const existing = await listSavedSessions();
        if (existing.length < 1) {
          await plusController.saveActive().catch(() => undefined);
        }
      }
      const finishResult = await plusController.finish({
        autosave: plusNow.entitlement.plusEnabled === true,
        reason: 'stop'
      });
      // finish returns: saved record (object with id) when permanently saved,
      // array of drafts when preserved as unsaved, or null on failure/empty.
      if (finishResult && !Array.isArray(finishResult) && typeof finishResult.id === 'string') {
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

  const plus = await getPlusSettings();
  const isFree = !plus.entitlement.plusEnabled;
  const maxProfiles = isFree ? 1 : 50;

  if (plus.rememberVolumes && targetOrigin) {
    const existingProfiles = plus.siteProfiles || [];
    const normalizedTarget = normalizeProfileOrigin(targetOrigin);
    const exists = existingProfiles.some((p) => p.origin === normalizedTarget);
    if (!exists && isFree && existingProfiles.length >= 1) {
      await chrome.storage.local.set({ [key]: volume });
      return { volume, plus, limitReached: true, upgradeRequired: true };
    }
    const profile = profileForOrigin(plus.siteProfiles, targetOrigin);
    const stored = await chrome.storage.local.get([STORAGE_KEYS.ORIGINAL_VOLUME, STORAGE_KEYS.DUBBED_VOLUME]);
    const defaultOrig = Number.isFinite(stored[STORAGE_KEYS.ORIGINAL_VOLUME]) ? stored[STORAGE_KEYS.ORIGINAL_VOLUME] : 0.25;
    const defaultDub = Number.isFinite(stored[STORAGE_KEYS.DUBBED_VOLUME]) ? stored[STORAGE_KEYS.DUBBED_VOLUME] : 1.0;
    const originalVolume = kind === 'original' ? volume : (profile?.originalVolume ?? sessionVolumes?.original ?? defaultOrig);
    const dubbedVolume = kind === 'dubbed' ? volume : (profile?.dubbedVolume ?? sessionVolumes?.dubbed ?? defaultDub);
    const profiles = upsertProfile(plus.siteProfiles, { origin: targetOrigin, originalVolume, dubbedVolume }, maxProfiles);
    await chrome.storage.local.set({ [STORAGE_KEYS.PLUS_SITE_PROFILES]: profiles });
    return { volume, plus: { ...plus, siteProfiles: profiles } };
  } else {
    await chrome.storage.local.set({ [key]: volume });
    return { volume, plus };
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

// These three must be handled HERE in the worker (checkout needs chrome.tabs,
// verification/polling need cross-origin fetch) — but their names start with
// PLUS_, so without this explicit set the generic PLUS_* delegation below
// swallows them and every payment button silently falls back to the static
const WORKER_HANDLED_PLUS_TYPES = new Set(['PLUS_START_CHECKOUT', 'PLUS_RECOVER_LICENSE', 'PLUS_ROTATE_RECOVERY', 'PLUS_POLL_LICENSE', 'PLUS_SET_LOCAL_SAVING', 'PLUS_GET_LOCAL_SAVING']);

async function handleUiMessage(message) {
  if (WORKER_HANDLED_PLUS_TYPES.has(message.type)) {
    switch (message.type) {
      case 'PLUS_RECOVER_LICENSE': {
        const activated = await recoverLicenseWithCode(message.code);
        chrome.runtime.sendMessage({ type: 'PLUS_LICENSE_ACTIVATED', plus: activated.plus }).catch(() => undefined);
        return { ok: true, plus: activated.plus };
      }
      case 'PLUS_ROTATE_RECOVERY':
        return rotateRecoveryCode();
      case 'PLUS_START_CHECKOUT':
        return startCheckout();
      case 'PLUS_POLL_LICENSE':
        return pollLicenseStatus();
      case 'PLUS_SET_LOCAL_SAVING':
        return { ok: true, plus: await setLocalSavingEnabled(message.value) };
      case 'PLUS_GET_LOCAL_SAVING':
        return { ok: true, plus: await getPlusSettings() };
    }
  }
  if (String(message.type || '').startsWith('PLUS_')) {
    return handlePlusMessage(message);
  }
  switch (message.type) {
    case 'GET_STATE':
      await initialStateReady;
      return {
        ok: true,
        // Same enriched shape as STATE_CHANGED broadcasts: consumers read
        // response.state, so the effective volumes must live inside it.
        state: { ...state, sessionVolumes: ACTIVE_STATUSES.has(state.status) ? sessionVolumes : null },
        settings: await getSettings(),
        plus: await getPlusSettings()
      };
    case 'GET_STATS':
      await initialStateReady;
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
      // Forward the tier-cap flags — the popup shows the upgrade modal on
      // these. Dropping them silently disabled the free-site cap.
      return {
        ok: true,
        value: result.volume,
        plus: result.plus,
        limitReached: result.limitReached === true,
        upgradeRequired: result.upgradeRequired === true
      };
    }
    case 'SET_AUTO_DUCKING':
      return { ok: true, value: await setAutoDucking(message.enabled) };
    case 'SET_UI_LANGUAGE':
      return { ok: true, value: await setUiLanguage(message.language) };
    case 'SET_ANALYTICS_CONSENT':
      await setAnalyticsConsent(message.value);
      return { ok: true, settings: await getSettings() };
    case 'GET_FEEDBACK_URL':
      return { ok: true, url: await feedbackPageUrl(message.source || 'popup') };
    default:
      return { ok: false, error: 'طلب غير معروف.' };
  }
}

let checkoutInFlight = null;

// Server error codes -> user-facing Arabic. Raw codes must never reach the UI.
const CHECKOUT_ERROR_MESSAGES = {
  rate_limited: 'عدد محاولات الترقية كبير اليوم. حاول غداً أو فعّل عبر رمز الاسترداد.',
  already_active: 'Plus مفعّل بالفعل على هذا الجهاز.',
  stripe_not_configured: 'الدفع غير متاح حالياً. حاول لاحقاً.',
  origin_not_allowed: 'تعذر إنشاء جلسة الدفع. تأكد من تحديث الإضافة لآخر إصدار.',
  invalid_request: 'تعذر إنشاء جلسة الدفع. حدّث الإضافة وحاول مجدداً.',
  checkout_failed: 'تعذر إنشاء جلسة الدفع. حاول لاحقاً.'
};

async function startCheckout() {
  if (checkoutInFlight) return checkoutInFlight;
  checkoutInFlight = (async () => {
    const { installId, installCredential } = await ensureInstallIdentity();
    let checkoutUrl = null;
    try {
      const res = await fetch('https://audiofetcher.com/dablaja/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ install_id: installId, install_credential: installCredential }),
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        throw new Error(CHECKOUT_ERROR_MESSAGES[data?.error] || 'تعذر إنشاء جلسة الدفع. حاول لاحقاً.');
      }
      checkoutUrl = normalizeStripeCheckoutUrl(data.url);
      if (!checkoutUrl) {
        throw new Error('تعذر التحقق من رابط الدفع الآمن. حاول لاحقاً.');
      }
    } catch (error) {
      throw new Error(error?.message || 'تعذر إنشاء جلسة الدفع. حاول لاحقاً.');
    }
    try {
      await chrome.tabs.create({ url: checkoutUrl });
    } catch {
      throw new Error('تعذر فتح صفحة الدفع. افتح نافذة Chrome وحاول مجدداً.');
    }
    await startLicensePolling();
    return { ok: true };
  })().finally(() => {
    checkoutInFlight = null;
  });
  return checkoutInFlight;
}

let pollingAttempts = 0;
const MAX_POLL_ATTEMPTS = 10; // 1-minute alarm × 10 attempts + immediate first poll = ~10 minutes, Chrome 116 compat
const LICENSE_ALARM = 'dablajaLicensePoll';
const POLL_STATE_KEY = 'licensePollState';
// MV3 suspends idle service workers within ~30 s, so setInterval cannot
// outlive the worker that scheduled it. chrome.alarms wakes the worker
// itself, which is what makes polling actually work. Use 1-minute minimum
// for Chrome 116 compatibility.
const ALARM_PERIOD_MINUTES = 1;

// Separate periodic license renewal lifecycle — production module shared
// with the test suite (dependency-injected).
const licenseRefresh = createLicenseRefreshCoordinator({
  storage: {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    alarms: chrome.alarms
  },
  identity: async () => {
    const { installId, installCredential } = await ensureInstallIdentity();
    return { installId, installCredential };
  },
  onRevoked: async () => {
    await chrome.alarms.clear(REFRESH_ALARM_NAME).catch(() => undefined);
    chrome.runtime.sendMessage({ type: 'PLUS_LICENSE_REVOKED', plus: await getPlusSettings() }).catch(() => undefined);
  },
  onActivated: async () => {
    chrome.runtime.sendMessage({ type: 'PLUS_LICENSE_ACTIVATED', plus: await getPlusSettings() }).catch(() => undefined);
  }
});

async function reconcileLicenseWithServer() {
  return licenseRefresh.reconcileLicenseWithServer();
}

async function startLicensePolling() {
  await stopLicensePolling();
  const stored = await chrome.storage.session.get(POLL_STATE_KEY);
  pollingAttempts = Number(stored[POLL_STATE_KEY]?.attempts) || 0;
  if (pollingAttempts >= MAX_POLL_ATTEMPTS) return;
  // Persist polling state to recover after service-worker suspension/restart
  await chrome.storage.session.set({ [POLL_STATE_KEY]: { attempts: pollingAttempts, active: true } });
  await chrome.alarms.create(LICENSE_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
  // Immediate first poll without waiting for alarm
  try {
    await pollAndHandle();
  } catch {}
}

async function stopLicensePolling() {
  pollingAttempts = 0;
  await chrome.alarms.clear(LICENSE_ALARM).catch(() => undefined);
  await chrome.storage.session.remove(POLL_STATE_KEY).catch(() => undefined);
  await chrome.storage.session.remove('licensePollAttempts').catch(() => undefined);
}

async function pollAndHandle() {
  const stored = await chrome.storage.session.get(POLL_STATE_KEY);
  const state = stored[POLL_STATE_KEY];
  if (!state?.active) return;
  const attempts = Number(state.attempts) || 0;
  if (attempts >= MAX_POLL_ATTEMPTS) {
    await stopLicensePolling();
    chrome.runtime.sendMessage({ type: 'PLUS_POLL_TIMEOUT', error: 'انتهت مهلة التفعيل. حاول مجدداً.' }).catch(() => undefined);
    return;
  }
  try {
    const result = await pollLicenseStatus();
    if (result?.ok && result?.token) {
      const activated = await handlePlusMessage({ type: 'PLUS_ACTIVATE_LICENSE', token: result.token, expectedInstallId: (await ensureInstallIdentity()).installId });
      if (activated?.ok) {
        await stopLicensePolling();
        chrome.runtime.sendMessage({ type: 'PLUS_LICENSE_ACTIVATED', plus: activated.plus }).catch(() => undefined);
        return;
      }
    }
    if (result?.ok && result?.license) {
      await stopLicensePolling();
      chrome.runtime.sendMessage({ type: 'PLUS_LICENSE_ACTIVATED', license: result.license, plus: result.plus }).catch(() => undefined);
      return;
    }
    if (result?.status === 'pending' || result?.status === 'none') {
      // continue polling; do not request token while pending
    } else if (result?.error) {
      await stopLicensePolling();
      chrome.runtime.sendMessage({ type: 'PLUS_POLL_FAILED', error: result.error }).catch(() => undefined);
      return;
    }
  } catch {
    // network errors continue polling
  }
  await chrome.storage.session.set({ [POLL_STATE_KEY]: { attempts: attempts + 1, active: true } });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LICENSE_ALARM) {
    (async () => {
      await pollAndHandle();
    })().catch(() => undefined);
  } else if (alarm.name === REFRESH_ALARM_NAME) {
    (async () => {
      await reconcileLicenseWithServer();
    })().catch(() => undefined);
  }
});

// On worker startup, recreate missing alarms and check stale/expired license
// Polling alarm is still managed here; license refresh startup is delegated
// entirely to the production coordinator so startup logic is single-sourced.
(async () => {
  try {
    const stored = await chrome.storage.session.get(POLL_STATE_KEY);
    const state = stored[POLL_STATE_KEY];
    if (state?.active && Number(state.attempts) < MAX_POLL_ATTEMPTS) {
      const alarms = await chrome.alarms.getAll().catch(() => []);
      if (!alarms.some((a) => a.name === LICENSE_ALARM)) {
        await chrome.alarms.create(LICENSE_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
      }
    }
    await licenseRefresh.startupCheck().catch(() => undefined);
  } catch {}
})();

async function pollLicenseStatus() {
  const { installId, installCredential } = await ensureInstallIdentity();
  try {
    const res = await fetch(LICENSE_STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_id: installId, install_credential: installCredential }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    if (data.ok && data.status === 'active') {
      try {
        const tokenRes = await fetch(LICENSE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ install_id: installId, install_credential: installCredential }),
          signal: AbortSignal.timeout(5000)
        });
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          if (tokenData?.ok && tokenData?.token) {
            return { ok: true, token: tokenData.token, licenseId: tokenData.licenseId };
          }
        }
      } catch {}
      return { ok: true, status: 'active' };
    }
    return { ok: true, status: data.status || 'none' };
  } catch {
    return { ok: false };
  }
}

async function rotateRecoveryCode() {
  const { installId, installCredential } = await ensureInstallIdentity();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.PLUS_LICENSE]);
  const token = stored[STORAGE_KEYS.PLUS_LICENSE]?.token || '';
  let data = null;
  try {
    const res = await fetch(ROTATE_RECOVERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_id: installId, install_credential: installCredential, token }),
      signal: AbortSignal.timeout(8000)
    });
    data = await res.json().catch(() => null);
  } catch {
    throw new Error('تعذر الاتصال بخدمة التفعيل. تحقق من الشبكة وحاول مجدداً.');
  }
  if (!data?.ok || !data?.code) {
    const messages = {
      unauthorized: 'تعذر التحقق من ترخيص Plus. أعد تفعيله ثم حاول مجدداً.',
      rate_limited: 'تم إجراء محاولات كثيرة اليوم. حاول لاحقاً.',
      origin_not_allowed: 'حدّث الإضافة إلى آخر إصدار ثم حاول مجدداً.'
    };
    throw new Error(messages[data?.error] || 'تعذر توليد رمز استرداد بديل.');
  }
  return { ok: true, code: data.code };
}

async function recoverLicenseWithCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^DABLAJA-[A-Z0-9]{20}$/.test(clean)) {
    throw new Error('رمز الاسترداد غير صالح. الصيغة: DABLAJA-XXXXXXXXXXXXXXXXXXXX');
  }
  const { installId, installCredential } = await ensureInstallIdentity();
  let data = null;
  try {
    const res = await fetch(RECOVER_LICENSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: clean, install_id: installId, install_credential: installCredential }),
      signal: AbortSignal.timeout(8000)
    });
    data = await res.json().catch(() => null);
  } catch {
    throw new Error('تعذر الاتصال بخدمة التفعيل. تحقق من الشبكة وحاول مجدداً.');
  }
  if (!data?.ok || !data?.token) {
    throw new Error('رمز الاسترداد غير صحيح أو منتهٍ.');
  }
  const activated = await handlePlusMessage({
    type: 'PLUS_ACTIVATE_LICENSE',
    token: data.token,
    expectedInstallId: installId
  });
  if (!activated?.ok) {
    throw new Error(activated?.error || 'فشل تفعيل الترخيص.');
  }
  return activated;
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
          code: message.errorKind || message.diagnosticCode || 'offscreen_fatal',
          message: message.message || 'حدث خطأ.',
          status: message.status || STATUS.ERROR,
          site: state.tabOrigin,
          reconnectCount: state.reconnectCount
        }))
        .then(() => plusController.finish({ autosave: false, reason: 'fatal' }))
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
        await reportRemoteError({
          code: 'start_failed',
          message: errorMessage,
          status: STATUS.ERROR,
          site: failedStartState.tabOrigin
        });
        sessionVolumes = null;
        await plusController.finish({ autosave: false, reason: 'start_failure' }).catch(() => undefined);
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});
