import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITLEMENT_STATES,
  PLUS_DEV_PREVIEW_ENABLED,
  PLUS_PREVIEW_LABEL,
  applyLicenseVerifier,
  describeEntitlement,
  isVerifiableLicenseRecord,
  resolveEntitlement
} from '../src/shared/plus-entitlement.js';

const VERIFIED_ACTIVE = {
  state: 'active',
  verifiedAt: 1,
  verifier: 'entitlement_endpoint',
  licenseId: 'lic-1'
};

test('development preview entitlement enables Plus and is clearly labelled', () => {
  assert.equal(PLUS_DEV_PREVIEW_ENABLED, true);
  const entitlement = resolveEntitlement({ devPreviewEnabled: true });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.DEVELOPMENT_PREVIEW);
  assert.equal(entitlement.plusEnabled, true);
  assert.ok(entitlement.label.includes('نسخة تطوير'));
});

test('a plain local { state: "active" } record does NOT unlock production Plus', () => {
  const entitlement = resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { state: 'active' }
  });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.LOCKED);
  assert.equal(entitlement.plusEnabled, false);
  // Same for richer but unverified forgeries.
  for (const forged of [
    { state: 'active', licensedAt: 1, orderId: 'order-1' },
    { state: 'active', verifiedAt: 'now' },
    { state: 'active', verifiedAt: 123, verifier: 'hope' },
    { state: 'ACTIVE', verifiedAt: 123, verifier: 'signed_token' },
    'active',
    42,
    null
  ]) {
    assert.equal(resolveEntitlement({ devPreviewEnabled: false, licenseRecord: forged }).plusEnabled, false);
  }
});

test('isVerifiableLicenseRecord accepts only the verifier-pipeline shape', () => {
  assert.equal(isVerifiableLicenseRecord(VERIFIED_ACTIVE), true);
  assert.equal(isVerifiableLicenseRecord({ ...VERIFIED_ACTIVE, verifier: 'signed_token' }), true);
  assert.equal(isVerifiableLicenseRecord(null), false);
  assert.equal(isVerifiableLicenseRecord([]), false);
  assert.equal(isVerifiableLicenseRecord({ state: 'weird', verifier: 'signed_token', verifiedAt: 1 }), false);
});

test('verified active license unlocks Plus without the preview label', () => {
  const entitlement = resolveEntitlement({ devPreviewEnabled: false, licenseRecord: VERIFIED_ACTIVE });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.ACTIVE);
  assert.equal(entitlement.plusEnabled, true);
  assert.equal(entitlement.preview, false);
});

test('verified expired and revoked records disable Plus with distinct labels', () => {
  const expired = resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { ...VERIFIED_ACTIVE, state: 'expired' }
  });
  assert.equal(expired.state, ENTITLEMENT_STATES.EXPIRED);
  assert.equal(expired.plusEnabled, false);
  const revoked = resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { ...VERIFIED_ACTIVE, state: 'revoked' }
  });
  assert.equal(revoked.state, ENTITLEMENT_STATES.REVOKED);
  assert.equal(revoked.plusEnabled, false);
});

test('a real verifier converts raw license material into a trusted record', () => {
  const mockVerifier = (raw) => raw?.token === 'good'
    ? { state: 'active', verifiedAt: 7, verifier: 'signed_token', licenseId: raw.id }
    : null;
  const entitlement = resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { token: 'good', id: 'lic-9' },
    verifier: mockVerifier
  });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.ACTIVE);
  // A verifier that rejects the material leaves Plus locked.
  const rejected = resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { token: 'bad' },
    verifier: mockVerifier
  });
  assert.equal(rejected.plusEnabled, false);
  // Verifier results that don't match the trusted shape are ignored.
  assert.equal(applyLicenseVerifier(() => ({ state: 'active' }), {}), null);
  assert.equal(applyLicenseVerifier(null, {}), null);
});

test('verified revoked license beats the development preview switch', () => {
  const entitlement = resolveEntitlement({
    devPreviewEnabled: true,
    licenseRecord: { ...VERIFIED_ACTIVE, state: 'revoked' }
  });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.REVOKED);
  assert.equal(entitlement.plusEnabled, false);
});

test('missing or malformed entitlement input defaults to locked', () => {
  assert.equal(resolveEntitlement({ devPreviewEnabled: false }).state, ENTITLEMENT_STATES.LOCKED);
  assert.equal(resolveEntitlement({ devPreviewEnabled: false, licenseRecord: undefined }).plusEnabled, false);
});

test('describeEntitlement localizes the preview warning', () => {
  const entitlement = resolveEntitlement({ devPreviewEnabled: true });
  assert.equal(describeEntitlement(entitlement, 'ar'), PLUS_PREVIEW_LABEL);
  assert.match(describeEntitlement(entitlement, 'en'), /development preview/i);
  assert.equal(describeEntitlement(null), '');
});
