// Production license refresh lifecycle, extracted from the MV3 service worker
// into an importable dependency-injected module so tests exercise the real
// implementation rather than a copy of it.
//
// Responsibilities:
//  • reconcileLicenseWithServer() — one coalesced server reconciliation pass
//    (status + fresh signed token), with fail-open offline semantics: network
//    failures retain the local token and never falsely revoke.
//  • ensureRefreshAlarm() — recreate the periodic refresh alarm after worker
//    suspension when a license record exists and is not revoked.
//  • startupCheck() — the worker-startup routine (alarm recreation plus a
//    stale/expired-triggered immediate reconciliation).
//
// All environment effects (chrome.storage, fetch, crypto verification,
// install identity) are injected; the module itself stays pure orchestration.

import { STORAGE_KEYS } from './constants.js';
import { LICENSE_STATUS_URL, LICENSE_TOKEN_URL, verifyLicenseToken, resolveEntitlement } from './plus-entitlement.js';

export const REFRESH_ALARM_NAME = 'dablajaLicenseRefresh';
export const REFRESH_INTERVAL_MINUTES = 720; // 12 hours
export const REFRESH_STALE_MS = 12 * 60 * 60 * 1000;

// Narrow the stored record to what reconciliation needs; guards against
// malformed storage shapes without trusting them.
function readStoredLicense(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const token = typeof record.token === 'string' ? record.token : '';
  return token ? { token } : null;
}

export function createLicenseRefreshCoordinator({
  storage,
  identity = async () => ({ installId: '', installCredential: '' }),
  fetchImpl = fetch,
  nowMs = () => Date.now(),
  verifyToken = verifyLicenseToken,
  resolveEntitlementFn = resolveEntitlement,
  onRevoked = async () => {},
  onActivated = async () => {}
} = {}) {
  if (!storage) throw new Error('createLicenseRefreshCoordinator requires a storage adapter');

  let inFlight = null;

  async function postJson(url, body) {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000)
      });
    } catch {
      return null; // network-level failure normalizes to "no response"
    }
  }

  // One network request per window regardless of how many callers join.
  function reconcileLicenseWithServer() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { installId, installCredential } = await identity();
        if (!installId || !installCredential) return { ok: false, reason: 'identity_unavailable' };

        const stored = await storage.get([STORAGE_KEYS.PLUS_LICENSE]);
        const currentLicense = readStoredLicense(stored[STORAGE_KEYS.PLUS_LICENSE]);
        if (!currentLicense) return { ok: true, skipped: 'no_license' };

        const authBody = {
          install_id: installId,
          install_credential: installCredential,
          token: currentLicense.token
        };

        let res = await postJson(LICENSE_STATUS_URL, authBody);
        if (!res || !res.ok) {
          // Network outage / non-200: retain the local token with offline
          // grace; never fabricate a revocation or expiry locally.
          return { ok: false, reason: res ? 'http_error' : 'network' };
        }
        let data = null;
        try {
          data = await res.json();
        } catch {
          return { ok: false, reason: 'malformed_json' };
        }
        if (!data || typeof data !== 'object' || data.ok !== true) {
          return { ok: false, reason: 'malformed_json' };
        }

        if (data.status === 'revoked') {
          // Server explicitly reports revoked: lock paid mutations now. The
          // old token bytes are kept only for diagnostics-free storage shape;
          // state flips and never unlocks anything again locally.
          await storage.set({
            [STORAGE_KEYS.PLUS_LICENSE]: {
              state: 'revoked',
              revokedAt: Date.now(),
              lastCheckedAt: Date.now(),
              token: currentLicense.token
            }
          });
          await onRevoked();
          return { ok: true, status: 'revoked' };
        }

        if (data.status === 'active') {
          const tokenRes = await postJson(LICENSE_TOKEN_URL, authBody);
          if (!tokenRes || !tokenRes.ok) return { ok: true, status: 'active', renewed: false };
          let tokenData = null;
          try {
            tokenData = await tokenRes.json();
          } catch {
            return { ok: true, status: 'active', renewed: false };
          }
          if (!tokenData || tokenData.ok !== true || typeof tokenData.token !== 'string') {
            return { ok: true, status: 'active', renewed: false };
          }
          const verified = await verifyToken(tokenData.token, {
            expectedInstallId: installId,
            nowMs: nowMs()
          });
          if (!verified) return { ok: true, status: 'active', renewed: false, invalid_signature: true };
          await storage.set({
            [STORAGE_KEYS.PLUS_LICENSE]: { ...verified, lastCheckedAt: nowMs() }
          });
          await onActivated(verified);
          return { ok: true, status: 'active', renewed: true };
        }

        return { ok: true, status: String(data.status || 'unknown') };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  // Returns true when the alarm already existed, false when it was created.
  async function ensureRefreshAlarm(entitlementState) {
    if (!entitlementState || entitlementState === 'revoked') return true;
    const alarms = await storage.alarms.getAll().catch(() => []);
    if (Array.isArray(alarms) && alarms.some((a) => a && a.name === REFRESH_ALARM_NAME)) return true;
    await storage.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });
    return false;
  }

  async function startupCheck() {
    const result = { alarmCreated: false, reconciled: false };
    const stored = await storage.get([STORAGE_KEYS.PLUS_LICENSE]).catch(() => ({}));
    const lic = stored[STORAGE_KEYS.PLUS_LICENSE];
    if (!lic || typeof lic !== 'object' || Array.isArray(lic)) return result;
    if (lic.state === 'revoked') return result;

    let iid = '';
    try {
      const idPair = await identity();
      iid = idPair?.installId || '';
    } catch {}
    if (!iid) return result;

    const ent = await resolveEntitlementFn({
      licenseRecord: lic,
      expectedInstallId: iid,
      nowMs: nowMs()
    }).catch(() => null);
    if (!ent) return result;
    const st = String(ent.state || '');
    if (st !== 'active' && st !== 'grace' && st !== 'expired') return result;

    result.alarmCreated = !(await ensureRefreshAlarm(st));
    const lastChecked = Number(lic.lastCheckedAt) || Number(lic.verifiedAt) || 0;
    const stale = nowMs() - lastChecked > REFRESH_STALE_MS;
    if (st === 'expired' || stale) {
      await reconcileLicenseWithServer();
      result.reconciled = true;
    }
    return result;
  }

  return {
    reconcileLicenseWithServer,
    ensureRefreshAlarm,
    startupCheck,
    isReconciling: () => inFlight !== null
  };
}
