// Central Plus entitlement boundary.
//
// SECURITY MODEL
//  • Production Plus unlocks only after an Ed25519-signed token issued by the
//    Dablaja backend and bound to this random installation identity.
//  • Tokens are valid for 30 days and receive a bounded seven-day offline
//    grace period. Reconciliation with the server renews, expires, or revokes
//    the local entitlement.
//  • A plain local { state: "active" } record never unlocks Plus.
//  • Cross-device recovery uses a one-time recovery code; payment cards remain
//    entirely with Stripe.
//  • The development-preview path is compile-time gated and release packaging
//    refuses while it is enabled.
//
// RELEASE GATE: scripts/validate-manifest.mjs fails release builds while the
// preview flag is on.

export const ENTITLEMENT_STATES = Object.freeze({
  UNAVAILABLE: 'unavailable',
  LOCKED: 'locked',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  DEVELOPMENT_PREVIEW: 'development_preview'
});

export const TIER_LIMITS = Object.freeze({
  FREE: {
    MAX_PROFILES: 1,
    MAX_SESSIONS: 1,
    MAX_BOOKMARKS_PER_SESSION: 1
  },
  PLUS: {
    MAX_PROFILES: 50,
    MAX_SESSIONS: 500,
    MAX_BOOKMARKS_PER_SESSION: 100
  }
});

export function getTierLimits(entitlement) {
  return entitlement?.plusEnabled === true ? TIER_LIMITS.PLUS : TIER_LIMITS.FREE;
}

// Development preview switch: now disabled since Stripe payment is connected live.
export const PLUS_DEV_PREVIEW_ENABLED = false;

export const STRIPE_PRODUCT_ID = 'prod_V6kibqrDgsGEXV';
export const STRIPE_PRICE_ID = 'price_1U6XCyIVWhSNOyU59PdmsbaP';
export const LICENSE_STATUS_URL = 'https://audiofetcher.com/dablaja/api/license-status';
export const LICENSE_TOKEN_URL = 'https://audiofetcher.com/dablaja/api/license-token';
export const RECOVER_LICENSE_URL = 'https://audiofetcher.com/dablaja/api/recover-license';
export const ROTATE_RECOVERY_URL = 'https://audiofetcher.com/dablaja/api/rotate-recovery';
export const RECOVERY_CODE_PATTERN = /^DABLAJA-[A-Z0-9]{20}$/;
export const PLUS_PRICE_LABEL = 'Plus · دفعة واحدة 10$ · بدون اشتراك';
export const PLUS_PREVIEW_LABEL = 'نسخة تطوير Plus — الدفع غير مربوط بعد';
export const PLUS_LOCKED_LABEL = 'النسخة المجانية — جلسة محفوظة واحدة';

const VERIFIABLE_STATES = new Set(['active', 'expired', 'revoked']);
// Trusted shape ONLY the signed-token verifier may write:
// { state, verifiedAt, verifier:'signed_token', licenseId, installId, issuedAt, expiresAt, token }
// licenseId must be non-empty and bounded, installId must match, token must be present.
export function isVerifiableLicenseRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (!VERIFIABLE_STATES.has(record.state)) return false;
  if (String(record.verifier || '') !== 'signed_token') return false;
  if (typeof record.licenseId !== 'string' || !record.licenseId.trim() || record.licenseId.length > 120) return false;
  if (typeof record.installId !== 'string' || !record.installId.trim() || record.installId.length > 80) return false;
  if (typeof record.token !== 'string' || !record.token.startsWith(TOKEN_PREFIX + '.')) return false;
  const verifiedAt = Number(record.verifiedAt);
  const issuedAt = Number(record.issuedAt);
  const expiresAt = Number(record.expiresAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt <= 0) return false;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return false;
  if (issuedAt >= expiresAt) return false;
  return true;
}

// Dependency-injected verifier contract used by tests and the production
// reconciliation pipeline.
// A verifier converts raw license material into a verifiable record (or null).
export function applyLicenseVerifier(verifier, licenseRecord) {
  if (typeof verifier !== 'function' || licenseRecord == null) return null;
  const result = verifier(licenseRecord);
  return isVerifiableLicenseRecord(result) ? result : null;
}

// ---------------------------------------------------------------------------
// Signed license tokens (Ed25519).
//
// The VPS holds DABLAJA_LICENSE_SIGNING_KEY and issues compact
//   dpl1.<payload>.<signature>
// tokens bound to install_id with a 30-day expiry. The PUBLIC half of the
// keypair lives here (public keys are not secret). Any stored license record
// that was not derived from a token with a valid signature can be deleted by
// the user without unlocking anything — forging requires the private key.
//
// Generate the keypair on the VPS: scripts/generate-license-key.py
// ---------------------------------------------------------------------------

export const TOKEN_PREFIX = 'dpl1';

// Paste the output of scripts/generate-license-key.py here after generating
// the signing key on the VPS. Empty means token verification fails closed.
export const PLUS_LICENSE_PUBLIC_KEY_B64 = 'COxNapFWerYUnlPhKDLaK/NO235eAU9L/RXowqtwnU4=';

function base64ToBytes(base64) {
  const binary = atob(String(base64).trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlToBytes(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
}

// Verifies a dpl1 token against the embedded public key and returns a
// verifiable license record, or null when anything at all is off.
// When expectedInstallId is provided, payload.iid must match exactly.
// Validates lid bounds, iat future skew, iat < exp, exp, and rejects
// malformed/extra-large payloads. Returns complete record with
// licenseId, installId, issuedAt, expiresAt, verifiedAt, verifier, token.
export async function verifyLicenseToken(token, {
  expectedInstallId = null,
  nowMs = Date.now(),
  publicKeyB64 = PLUS_LICENSE_PUBLIC_KEY_B64,
  allowExpired = false
} = {}) {
  if (!publicKeyB64 || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;

  let payloadBytes = null;
  let signature = null;
  try {
    payloadBytes = base64UrlToBytes(parts[1]);
    signature = base64UrlToBytes(parts[2]);
  } catch {
    return null;
  }
  // Sanity bounds before parsing or importing anything: payloads are tiny
  // JSON objects and Ed25519 signatures are exactly 64 bytes.
  if (!payloadBytes.length || payloadBytes.length > 1024 || signature.length !== 64) return null;

  let payload = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  const licenseId = payload && typeof payload.lid === 'string' ? payload.lid.slice(0, 120) : '';
  const installId = payload && typeof payload.iid === 'string' ? payload.iid.slice(0, 80) : '';
  const issuedAtSeconds = Number(payload?.iat);
  const expiresAtSeconds = Number(payload?.exp);
  if (!licenseId.trim()) return null;
  if (typeof installId !== 'string' || !installId.trim()) return null;
  if (expectedInstallId != null && installId !== String(expectedInstallId)) return null;
  if (!Number.isFinite(issuedAtSeconds) || !Number.isFinite(expiresAtSeconds)) return null;
  const issuedAtMs = issuedAtSeconds * 1000;
  const expiresAtMs = expiresAtSeconds * 1000;
  // iat must not be unreasonably in future (allow 5 min skew) and must precede exp
  if (issuedAtMs > nowMs + 5 * 60 * 1000) return null;
  if (issuedAtMs >= expiresAtMs) return null;
  if (!allowExpired && expiresAtMs <= nowMs) return null;
  if (!globalThis.crypto?.subtle) return null;

  try {
    const keyData = base64ToBytes(publicKeyB64);
    if (keyData.length !== 32) return null;
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'Ed25519' }, false, ['verify']);
    // The server signs ASCII("dpl1.") + raw payload bytes — reproduce that
    // exact byte string rather than re-serializing parsed JSON.
    const prefix = new TextEncoder().encode(`${TOKEN_PREFIX}.`);
    const signed = new Uint8Array(prefix.length + payloadBytes.length);
    signed.set(prefix, 0);
    signed.set(payloadBytes, prefix.length);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signed);
    if (!valid) return null;
    return {
      state: expiresAtMs > nowMs ? 'active' : 'expired',
      verifiedAt: nowMs,
      verifier: 'signed_token',
      licenseId: licenseId.trim(),
      installId,
      issuedAt: issuedAtMs,
      expiresAt: expiresAtMs,
      verifiedAtMs: nowMs,
      token
    };
  } catch {
    return null;
  }
}

export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days bounded offline grace
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function resolveEntitlement({
  devPreviewEnabled = PLUS_DEV_PREVIEW_ENABLED,
  licenseRecord = null,
  verifier = null,
  nowMs = Date.now(),
  expectedInstallId = null,
  publicKeyB64 = PLUS_LICENSE_PUBLIC_KEY_B64
} = {}) {
  if (licenseRecord && typeof licenseRecord === 'object' && !Array.isArray(licenseRecord) && licenseRecord.state === 'revoked') {
    return { state: ENTITLEMENT_STATES.REVOKED, plusEnabled: false, preview: false, label: 'تم إلغاء Plus' };
  }

  let token = null;
  if (typeof licenseRecord === 'string' && licenseRecord.startsWith(TOKEN_PREFIX + '.')) {
    token = licenseRecord;
  } else if (licenseRecord && typeof licenseRecord === 'object' && typeof licenseRecord.token === 'string') {
    token = licenseRecord.token;
  }

  let verified = null;
  if (typeof verifier === 'function') {
    const custom = await verifier(licenseRecord);
    if (custom && typeof custom === 'object') {
      if (typeof custom.token === 'string') {
        token = custom.token;
      } else if (isVerifiableLicenseRecord(custom) && custom.token) {
        token = custom.token;
      }
    }
  }

  if (token && typeof token === 'string') {
    verified = await verifyLicenseToken(token, {
      expectedInstallId,
      nowMs,
      publicKeyB64,
      allowExpired: true
    });
  }

  if (verified) {
    const state = String(licenseRecord?.state || verified.state).toLowerCase();
    if (state === 'revoked') {
      return { state: ENTITLEMENT_STATES.REVOKED, plusEnabled: false, preview: false, label: 'تم إلغاء Plus' };
    }
    if (state === 'expired') {
      return { state: ENTITLEMENT_STATES.EXPIRED, plusEnabled: false, preview: false, label: 'انتهت صلاحية Plus' };
    }

    const now = Number(nowMs) || Date.now();
    const expiresAt = Number(verified.expiresAt);
    if (Number.isFinite(expiresAt)) {
      if (now > expiresAt + OFFLINE_GRACE_MS) {
        return { state: ENTITLEMENT_STATES.EXPIRED, plusEnabled: false, preview: false, label: 'انتهت صلاحية Plus' };
      }
      if (now > expiresAt) {
        // Within bounded 7-day offline grace period
        return { state: ENTITLEMENT_STATES.ACTIVE, plusEnabled: true, preview: false, label: 'Plus' };
      }
    } else {
      return { state: ENTITLEMENT_STATES.LOCKED, plusEnabled: false, preview: false, label: PLUS_LOCKED_LABEL };
    }

    return { state: ENTITLEMENT_STATES.ACTIVE, plusEnabled: true, preview: false, label: 'Plus' };
  }

  if (devPreviewEnabled === true) {
    return {
      state: ENTITLEMENT_STATES.DEVELOPMENT_PREVIEW,
      plusEnabled: true,
      preview: true,
      label: PLUS_PREVIEW_LABEL
    };
  }

  // Missing, malformed, or unverified entitlement data always defaults to locked.
  return { state: ENTITLEMENT_STATES.LOCKED, plusEnabled: false, preview: false, label: PLUS_LOCKED_LABEL };
}

export function describeEntitlement(entitlement, language = 'ar') {
  if (!entitlement) return '';
  if (entitlement.state === ENTITLEMENT_STATES.DEVELOPMENT_PREVIEW) {
    return language === 'en'
      ? 'Dablaja Plus development preview — payment not connected yet'
      : PLUS_PREVIEW_LABEL;
  }
  return entitlement.label || '';
}
