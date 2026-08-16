import { STORAGE_KEYS, originOf } from './constants.js';

export const DABLAJA_ORIGIN = 'https://audiofetcher.com';
export const DABLAJA_BASE = `${DABLAJA_ORIGIN}/dablaja`;

const SKIP = [
  'أدخل مفتاح',
  'صيغة مفتاح',
  'يجب الموافقة',
  'افتح صفحة',
  'أوقف الدبلجة الحالية'
];

export async function ensureInstallId() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.INSTALL_ID);
  const current = stored[STORAGE_KEYS.INSTALL_ID];
  if (typeof current === 'string' && current.length >= 16) return current;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.INSTALL_ID]: id });
  return id;
}

export async function configureUninstallUrl() {
  const id = await ensureInstallId();
  const url = new URL(`${DABLAJA_BASE}/uninstall`);
  url.searchParams.set('install_id', id);
  url.searchParams.set('source', 'chrome');
  await chrome.runtime.setUninstallURL(url.toString());
}

export async function feedbackPageUrl(source = 'popup') {
  const id = await ensureInstallId();
  const url = new URL(`${DABLAJA_BASE}/feedback`);
  url.searchParams.set('install_id', id);
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
    await fetch(`${DABLAJA_BASE}/api/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_500)
    });
    return true;
  } catch {
    return false;
  }
}

export function shouldReportMessage(message = '') {
  const text = String(message || '');
  return !SKIP.some((prefix) => text.includes(prefix));
}

let lastReport = '';

export async function reportRemoteError(payload = {}) {
  const message = String(payload.message || '');
  if (!shouldReportMessage(message)) return;
  const stamp = `${payload.code || ''}|${message.slice(0, 80)}|${payload.site || ''}`;
  if (stamp === lastReport) return;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.ANALYTICS_CONSENT);
    if (stored[STORAGE_KEYS.ANALYTICS_CONSENT] !== true) return;
    lastReport = stamp;
    const manifest = chrome.runtime.getManifest();
    await fetch(`${DABLAJA_BASE}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: crypto.randomUUID(),
        error_code: String(payload.code || 'unknown').slice(0, 80),
        error_message: message.slice(0, 400),
        status: String(payload.status || '').slice(0, 40),
        site_host: platformCategory(payload.site),
        extension_version: manifest.version,
        reconnect_count: Number(payload.reconnectCount) || 0
      })
    });
  } catch {
    lastReport = '';
  }
}
