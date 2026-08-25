import { STORAGE_KEYS, originOf } from './constants.js';

export const DABLAJA_ORIGIN = 'https://audiofetcher.com';
export const DABLAJA_BASE = `${DABLAJA_ORIGIN}/dablaja`;

// Single-flight installation identity. Every caller shares one in-flight
// promise; both keys are read together, missing values are generated exactly
// once, and both are persisted in ONE chrome.storage.local.set call so an
// install_id / install_credential pair can never be mixed across generations.
let installIdentityPromise = null;

function randomInstallCredential() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function ensureInstallIdentity() {
  if (!installIdentityPromise) {
    installIdentityPromise = (async () => {
      const stored = await chrome.storage.local.get([STORAGE_KEYS.INSTALL_ID, STORAGE_KEYS.PLUS_INSTALL_CREDENTIAL]);
      const currentId = stored[STORAGE_KEYS.INSTALL_ID];
      const currentCred = stored[STORAGE_KEYS.PLUS_INSTALL_CREDENTIAL];
      const idValid = typeof currentId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(currentId);
      const credValid = typeof currentCred === 'string' && /^[0-9a-f]{64}$/i.test(currentCred);
      const credLower = credValid ? String(currentCred).toLowerCase() : null;
      const needsNormalization = credValid && String(currentCred) !== credLower;
      const idFinal = idValid ? currentId : crypto.randomUUID();
      const credFinal = credValid ? credLower : randomInstallCredential();
      const needsWrite = !idValid || !credValid || needsNormalization;
      if (needsWrite) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.INSTALL_ID]: idFinal,
          [STORAGE_KEYS.PLUS_INSTALL_CREDENTIAL]: credFinal
        });
      }
      return { installId: idFinal, installCredential: credFinal };
    })();
    // Clear the single-flight window on success OR failure so failures are
    // retryable; the catch keeps the cleanup branch itself from rejecting.
    installIdentityPromise.catch(() => undefined).finally(() => {
      installIdentityPromise = null;
    });
  }
  return installIdentityPromise;
}

export async function configureUninstallUrl() {
  const url = new URL(`${DABLAJA_BASE}/uninstall`);
  url.searchParams.set('source', 'chrome');
  await chrome.runtime.setUninstallURL(url.toString());
}

export async function feedbackPageUrl(source = 'popup') {
  const url = new URL(`${DABLAJA_BASE}/feedback`);
  url.searchParams.set('source', source);
  return url.toString();
}

function siteHost(site) {
  const origin = originOf(site || '') || site || '';
  try {
    return new URL(origin.includes('://') ? origin : `https://${origin}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function platformCategory(site = '') {
  const host = siteHost(site);
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
  return 'other';
}

export function usageEventPayload({ site = '', dubbedMs = 0, eventId = '' } = {}) {
  const duration = Math.max(0, Math.min(8 * 60 * 60 * 1000, Math.round(Number(dubbedMs) || 0)));
  if (duration < 5_000) return null;
  return {
    event_id: String(eventId || crypto.randomUUID()),
    platform: platformCategory(site),
    dubbed_ms: duration
  };
}

export async function reportUsageSession({ site = '', dubbedMs = 0 } = {}) {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.ANALYTICS_CONSENT);
    if (stored[STORAGE_KEYS.ANALYTICS_CONSENT] !== true) return false;
    const payload = usageEventPayload({ site, dubbedMs });
    if (!payload) return false;
    const response = await fetch(`${DABLAJA_BASE}/api/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

const ALLOWED_ERROR_CODES = new Set([
  'network_error',
  'api_key_invalid',
  'model_unavailable',
  'rate_limited',
  'connection_failed',
  'stream_closed',
  'audio_capture_failed',
  'setup_failed',
  'worker_unresponsive',
  'timeout',
  'start_failed',
  'offscreen_fatal',
  'unknown'
]);

const ALLOWED_STATUSES = new Set([
  'connecting',
  'listening',
  'translating',
  'reconnecting',
  'rate_limited',
  'error',
  'stopped',
  'ready',
  'no_key'
]);

let lastReport = '';

export async function reportRemoteError(payload = {}) {
  const rawCode = String(payload.code || 'unknown').toLowerCase();
  const errorCode = ALLOWED_ERROR_CODES.has(rawCode) ? rawCode : 'unknown';
  const rawStatus = String(payload.status || '').toLowerCase();
  const status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : '';
  const stamp = `${errorCode}|${status}|${payload.site || ''}`;
  if (stamp === lastReport) return false;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.ANALYTICS_CONSENT);
    if (stored[STORAGE_KEYS.ANALYTICS_CONSENT] !== true) return;
    lastReport = stamp;
    const manifest = chrome.runtime.getManifest();
    const reconnectCount = Math.max(0, Math.min(10, Math.floor(Number(payload.reconnectCount) || 0)));
    const response = await fetch(`${DABLAJA_BASE}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: crypto.randomUUID(),
        error_code: errorCode,
        status,
        site_host: platformCategory(payload.site),
        extension_version: manifest.version,
        reconnect_count: reconnectCount
      }),
      signal: AbortSignal.timeout(2_500)
    });
    if (!response.ok) throw new Error('diagnostic_rejected');
    return true;
  } catch {
    lastReport = '';
    return false;
  }
}
