import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITLEMENT_STATES,
  PLUS_DEV_PREVIEW_ENABLED,
  PLUS_PREVIEW_LABEL,
  LICENSE_STATUS_URL,
  LICENSE_TOKEN_URL,
  RECOVER_LICENSE_URL,
  ROTATE_RECOVERY_URL,
  OFFLINE_GRACE_MS,
  TOKEN_TTL_MS,
  applyLicenseVerifier,
  describeEntitlement,
  isVerifiableLicenseRecord,
  resolveEntitlement,
  verifyLicenseToken
} from '../src/shared/plus-entitlement.js';

const webcrypto = globalThis.crypto;
const encoder = new TextEncoder();

function b64u(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createTestKeyAndSigner() {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const publicKeyB64 = Buffer.from(pubRaw).toString('base64');
  async function signToken(payload) {
    const raw = encoder.encode(JSON.stringify(payload));
    const prefix = encoder.encode('dpl1.');
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix, 0);
    signed.set(raw, prefix.length);
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, signed));
    return `dpl1.${b64u(raw)}.${b64u(sig)}`;
  }
  return { publicKeyB64, signToken };
}

test('development preview entitlement flag is disabled by default for production gating and works when enabled', async () => {
  assert.equal(PLUS_DEV_PREVIEW_ENABLED, false);
  const entitlement = await resolveEntitlement({ devPreviewEnabled: true });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.DEVELOPMENT_PREVIEW);
  assert.equal(entitlement.plusEnabled, true);
  assert.ok(entitlement.label.includes('نسخة تطوير'));
});

test('a plain local { state: "active" } record does NOT unlock production Plus', async () => {
  const entitlement = await resolveEntitlement({
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
    const res = await resolveEntitlement({ devPreviewEnabled: false, licenseRecord: forged });
    assert.equal(res.plusEnabled, false);
  }
});

test('isVerifiableLicenseRecord accepts only the verifier-pipeline shape', () => {
  const VERIFIED_ACTIVE = {
    state: 'active',
    verifiedAt: Date.now(),
    verifier: 'signed_token',
    licenseId: 'lic-1',
    installId: 'test-install-12345678',
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    token: 'dpl1.eyJsaWQiOiJsaWMtMSIsImlpZCI6InRlc3QtaW5zdGFsbC0xMjM0NTY3OCIsImlhdCI6MTIzLCJleHAiOjk5OTk5OTk5OTl9.sig'
  };
  assert.equal(isVerifiableLicenseRecord(VERIFIED_ACTIVE), true);
  assert.equal(isVerifiableLicenseRecord({ ...VERIFIED_ACTIVE, verifier: 'entitlement_endpoint' }), false);
  assert.equal(isVerifiableLicenseRecord(null), false);
  assert.equal(isVerifiableLicenseRecord([]), false);
  assert.equal(isVerifiableLicenseRecord({ state: 'weird', verifier: 'signed_token', verifiedAt: 1 }), false);
});

test('cryptographically verified active license unlocks Plus without the preview label', async () => {
  const { publicKeyB64, signToken } = await createTestKeyAndSigner();
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signToken({
    lid: 'lic-test-1',
    iid: 'test-install-12345678',
    iat: nowSec - 10,
    exp: nowSec + 30 * 86400
  });

  const entitlement = await resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { token },
    expectedInstallId: 'test-install-12345678',
    publicKeyB64
  });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.ACTIVE);
  assert.equal(entitlement.plusEnabled, true);
  assert.equal(entitlement.preview, false);
});

test('tampered payload or copied token to another install leaves Plus locked', async () => {
  const { publicKeyB64, signToken } = await createTestKeyAndSigner();
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signToken({
    lid: 'lic-test-1',
    iid: 'install-user-A',
    iat: nowSec - 10,
    exp: nowSec + 30 * 86400
  });

  // Copied token to install-user-B
  const copied = await resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { token },
    expectedInstallId: 'install-user-B',
    publicKeyB64
  });
  assert.equal(copied.plusEnabled, false);
  assert.equal(copied.state, ENTITLEMENT_STATES.LOCKED);

  // Altered payload byte
  const parts = token.split('.');
  const tamperedPayload = b64u(encoder.encode(JSON.stringify({
    lid: 'lic-test-1',
    iid: 'install-user-B',
    iat: nowSec - 10,
    exp: nowSec + 30 * 86400
  })));
  const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
  const tampered = await resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { token: tamperedToken },
    expectedInstallId: 'install-user-B',
    publicKeyB64
  });
  assert.equal(tampered.plusEnabled, false);
  assert.equal(tampered.state, ENTITLEMENT_STATES.LOCKED);
});

test('verified expired beyond grace and revoked records disable Plus with distinct labels', async () => {
  const { publicKeyB64, signToken } = await createTestKeyAndSigner();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredToken = await signToken({
    lid: 'lic-test-1',
    iid: 'install-A',
    iat: nowSec - 100 * 86400,
    exp: nowSec - 10 * 86400 // Expired 10 days ago (beyond 7 days grace)
  });

  const expired = await resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { token: expiredToken },
    expectedInstallId: 'install-A',
    publicKeyB64
  });
  assert.equal(expired.state, ENTITLEMENT_STATES.EXPIRED);
  assert.equal(expired.plusEnabled, false);

  const revoked = await resolveEntitlement({
    devPreviewEnabled: false,
    licenseRecord: { state: 'revoked', token: expiredToken }
  });
  assert.equal(revoked.state, ENTITLEMENT_STATES.REVOKED);
  assert.equal(revoked.plusEnabled, false);
});

test('verified revoked license beats the development preview switch', async () => {
  const entitlement = await resolveEntitlement({
    devPreviewEnabled: true,
    licenseRecord: { state: 'revoked' }
  });
  assert.equal(entitlement.state, ENTITLEMENT_STATES.REVOKED);
  assert.equal(entitlement.plusEnabled, false);
});

test('missing or malformed entitlement input defaults to locked', async () => {
  assert.equal((await resolveEntitlement({ devPreviewEnabled: false })).state, ENTITLEMENT_STATES.LOCKED);
  assert.equal((await resolveEntitlement({ devPreviewEnabled: false, licenseRecord: undefined })).plusEnabled, false);
});

test('describeEntitlement localizes the preview warning', async () => {
  const entitlement = await resolveEntitlement({ devPreviewEnabled: true });
  assert.equal(describeEntitlement(entitlement, 'ar'), PLUS_PREVIEW_LABEL);
  assert.match(describeEntitlement(entitlement, 'en'), /development preview/i);
  assert.equal(describeEntitlement(null), '');
});

test('payment endpoints point at the VPS API and no static payment link exists', async () => {
  assert.ok(LICENSE_STATUS_URL.startsWith('https://audiofetcher.com/dablaja/api/license-status'));
  assert.ok(LICENSE_TOKEN_URL.startsWith('https://audiofetcher.com/dablaja/api/license-token'));
  assert.ok(RECOVER_LICENSE_URL.startsWith('https://audiofetcher.com/dablaja/api/recover-license'));
  assert.ok(ROTATE_RECOVERY_URL.startsWith('https://audiofetcher.com/dablaja/api/rotate-recovery'));
  // The static buy.stripe.com fallback was removed from the entire codebase:
  // every checkout must go through the install-bound server endpoint.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['src/shared/plus-entitlement.js', 'src/popup/popup.js', 'src/library/library.js', 'src/stats/stats.js']) {
    const text = await readFile(path.join(root, rel), 'utf8');
    assert.ok(!text.includes('buy.stripe.com'), `${rel} must not contain a static Stripe link`);
    assert.ok(!text.includes('STRIPE_PAYMENT_LINK'), `${rel} must not reference STRIPE_PAYMENT_LINK`);
  }
});
