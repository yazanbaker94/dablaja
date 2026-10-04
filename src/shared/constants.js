export const MODEL = 'gemini-3.5-live-translate-preview';
export const API_HOST = 'generativelanguage.googleapis.com';
export const API_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const INPUT_SAMPLE_RATE = 16_000;
export const OUTPUT_SAMPLE_RATE = 24_000;
export const INPUT_CHUNK_MS = 100;
export const TARGET_LANGUAGE = 'ar';

export const STORAGE_KEYS = Object.freeze({
  API_KEY: 'geminiApiKey',
  ORIGINAL_VOLUME: 'originalVolume',
  DUBBED_VOLUME: 'dubbedVolume',
  AUTO_DUCKING: 'autoDucking',
  UI_LANGUAGE: 'uiLanguage',
  USAGE_STATS: 'localUsageStats',
  LIBRARY_REMEMBER_VOLUMES: 'plusRememberVolumes',
  LIBRARY_SITE_PROFILES: 'plusSiteProfiles',
  // Preserve the original on-disk key so existing users keep their choice.
  LIBRARY_LOCAL_SAVING_ENABLED: 'plusLocalLibraryConsent'
});

export const SESSION_STORAGE_KEYS = Object.freeze({
  LIBRARY_ACTIVE_DRAFT: 'plusActiveDraft',
  LIBRARY_UNSAVED_DRAFTS: 'plusUnsavedDrafts'
});

export const DEFAULTS = Object.freeze({
  originalVolume: 0.25,
  dubbedVolume: 1,
  autoDucking: true,
  uiLanguage: 'ar'
});

export const STATUS = Object.freeze({
  NO_KEY: 'no_key',
  READY: 'ready',
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  TRANSLATING: 'translating',
  RECONNECTING: 'reconnecting',
  RATE_LIMITED: 'rate_limited',
  STOPPED: 'stopped',
  ERROR: 'error'
});

export const ACTIVE_STATUSES = new Set([
  STATUS.CONNECTING,
  STATUS.LISTENING,
  STATUS.TRANSLATING,
  STATUS.RECONNECTING,
  STATUS.RATE_LIMITED
]);

export const SESSION_STATE_KEY = 'runtimeState';

export function originOf(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

export function publicState(overrides = {}) {
  return {
    status: STATUS.STOPPED,
    message: '',
    tabId: null,
    tabOrigin: null,
    startedAt: null,
    latencyMs: null,
    outputBufferMs: 0,
    targetBufferMs: 280,
    playbackUnderruns: 0,
    playbackActive: false,
    sentAudioMs: 0,
    reconnectCount: 0,
    heapEstimateMb: null,
    reconnectAttempt: 0,
    sourcePaused: false,
    diagnosticCode: null,
    ...overrides
  };
}
