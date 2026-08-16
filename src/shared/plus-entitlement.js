// Central Plus entitlement boundary.
//
// SECURITY MODEL
//  • Only two paths can ever unlock Plus:
//      1. development_preview — a build-time/testing switch (never shippable).
//      2. A *verified* production license produced by the Stripe-phase
//         verifier pipeline (see STRIPE_INTEGRATION_CONTRACT below).
//  • A plain local { state: "active" } record in chrome.storage.local is NOT
//    trusted evidence. It cannot unlock anything. Forging the verified record
//    shape requires the real signing key / entitlement endpoint, neither of
//    which exists in this phase.
//
// STRIPE INTEGRATION CONTRACT (later phase — nothing here is faked now)
//  1. Purchase: Stripe checkout (hosted) → webhook on the Dablaja VPS issues a
//     signed license token bound to a license id (Ed25519, embedded public key
//     in the extension) OR the extension queries the VPS entitlement endpoint
//     with the license id and caches the signed result.
//  2. Verification pipeline (service worker):
//       verifyLicense(rawLicenseRecord) → writes ONLY the verified result to
//       chrome.storage.local: { state, verifiedAt, verifier, licenseId }.
//     resolveEntitlement() accepts that shape exclusively via
//     isVerifiableLicenseRecord().
//  3. Offline grace: a verified record stays valid for a grace window
//     (e.g. 30 days) past its last verifiedAt; after that it degrades to
//     expired and re-verification is prompted.
//  4. Cross-device/reinstall recovery: the user re-enters their license id
//     (or restores it from a backup) and the verifier re-issues a verified
//     record; no device-bound identifiers are used.
//  5. Refunds/revocation: the VPS revokes the license id; the next
//     verification (or expiry of the offline grace window) flips the local
//     record to revoked. Revoked users keep read/export/delete access to
//     already-saved local data.
//  6. Replace PLUS_DEV_PREVIEW_ENABLED with false; `npm run package:release`
//     already refuses while it is true.
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

// Development preview switch: lets every Plus feature run locally before
// Stripe exists. Not a production bypass — package:release refuses to build
// while this is true.
export const PLUS_DEV_PREVIEW_ENABLED = true;

export const PLUS_PRICE_LABEL = 'Plus · دفعة واحدة 10$ · بدون اشتراك';
export const PLUS_PREVIEW_LABEL = 'نسخة تطوير Plus — الدفع غير مربوط بعد';
export const PLUS_LOCKED_LABEL = 'Plus غير مفعّل';

const VERIFIABLE_STATES = new Set(['active', 'expired', 'revoked']);
const VERIFIER_SOURCES = new Set(['signed_token', 'entitlement_endpoint']);

// Trusted shape ONLY the Stripe-phase verifier pipeline may write:
// { state, verifiedAt, verifier, licenseId } — lowercase state, exact fields.
export function isVerifiableLicenseRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (!VERIFIABLE_STATES.has(record.state)) return false;
  if (!VERIFIER_SOURCES.has(String(record.verifier || ''))) return false;
  const verifiedAt = Number(record.verifiedAt);
  return Number.isFinite(verifiedAt) && verifiedAt > 0;
}

// Mock/real verifier contract for tests and the future pipeline.
// A verifier converts raw license material into a verifiable record (or null).
export function applyLicenseVerifier(verifier, licenseRecord) {
  if (typeof verifier !== 'function' || licenseRecord == null) return null;
  const result = verifier(licenseRecord);
  return isVerifiableLicenseRecord(result) ? result : null;
}

export function resolveEntitlement({
  devPreviewEnabled = PLUS_DEV_PREVIEW_ENABLED,
  licenseRecord = null,
  verifier = null
} = {}) {
  const verified = isVerifiableLicenseRecord(licenseRecord)
    ? licenseRecord
    : applyLicenseVerifier(verifier, licenseRecord);
  if (verified) {
    const state = String(verified.state).toLowerCase();
    if (state === 'active') {
      return { state: ENTITLEMENT_STATES.ACTIVE, plusEnabled: true, preview: false, label: 'Plus' };
    }
    return {
      state: state === 'expired' ? ENTITLEMENT_STATES.EXPIRED : ENTITLEMENT_STATES.REVOKED,
      plusEnabled: false,
      preview: false,
      label: state === 'expired' ? 'انتهت صلاحية Plus' : 'تم إلغاء Plus'
    };
  }
  if (devPreviewEnabled === true) {
    return {
      state: ENTITLEMENT_STATES.DEVELOPMENT_PREVIEW,
      plusEnabled: true,
      preview: true,
      label: PLUS_PREVIEW_LABEL
    };
  }
  // Missing or malformed entitlement data always defaults to locked.
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
