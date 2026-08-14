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
  lastReport = stamp;
  try {
    const installId = await ensureInstallId();
    const manifest = chrome.runtime.getManifest();
    await fetch(`${DABLAJA_BASE}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: installId,
        error_code: String(payload.code || 'unknown').slice(0, 80),
        error_message: message.slice(0, 400),
        status: String(payload.status || '').slice(0, 40),
        site_host: siteHost(payload.site),
        extension_version: manifest.version,
        reconnect_count: Number(payload.reconnectCount) || 0
      })
    });
  } catch {
    lastReport = '';
  }
}
