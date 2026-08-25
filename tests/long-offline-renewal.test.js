import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntitlement,
  verifyLicenseToken,
  TOKEN_PREFIX,
  OFFLINE_GRACE_MS
} from '../src/shared/plus-entitlement.js';

// Helper to construct a cryptographically signed dpl1 token for tests
async function makeSignedToken({
  licenseId = 'lic_test_123',
  installId = 'install_test_00000000',
  iat = Math.floor(Date.now() / 1000) - 3600,
  exp = Math.floor(Date.now() / 1000) + 30 * 86400,
  keyPair = null
} = {}) {
  const kp = keyPair || await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const pubB64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));

  const payload = { lid: licenseId, iid: installId, iat, exp };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = btoa(payloadJson).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const prefix = new TextEncoder().encode(`${TOKEN_PREFIX}.`);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const signed = new Uint8Array(prefix.length + payloadBytes.length);
  signed.set(prefix, 0);
  signed.set(payloadBytes, prefix.length);

  const sigBytes = await crypto.subtle.sign('Ed25519', kp.privateKey, signed);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const token = `${TOKEN_PREFIX}.${payloadB64}.${sigB64}`;
  return { token, pubB64, keyPair: kp, payload };
}

// 1. Valid active token
test('valid active token: verifies and unlocks Plus locally', async () => {
  const nowSec = 1700000000;
  const nowMs = nowSec * 1000;
  const installId = 'inst_active_123456789012';

  const { token, pubB64 } = await makeSignedToken({
    installId,
    iat: nowSec - 3600,
    exp: nowSec + 30 * 86400
  });

  const authRecord = await verifyLicenseToken(token, {
    expectedInstallId: installId,
    nowMs,
    publicKeyB64: pubB64
  });
  assert.ok(authRecord, 'Valid active token must verify');
  assert.equal(authRecord.state, 'active');

  const ent = await resolveEntitlement({
    licenseRecord: authRecord,
    expectedInstallId: installId,
    publicKeyB64: pubB64,
    nowMs
  });
  assert.equal(ent.plusEnabled, true);
  assert.equal(ent.state, 'active');
});

// 2. Token in grace
test('token in grace: authentic token expired within 7-day grace unlocks Plus', async () => {
  const nowSec = 1700000000;
  const nowMs = nowSec * 1000;
  const installId = 'inst_grace_123456789012';

  // Expired 3 days ago (within 7-day grace)
  const { token, pubB64 } = await makeSignedToken({
    installId,
    iat: nowSec - 33 * 86400,
    exp: nowSec - 3 * 86400
  });

  const ent = await resolveEntitlement({
    licenseRecord: { token, state: 'active' },
    expectedInstallId: installId,
    publicKeyB64: pubB64,
    nowMs
  });
  assert.equal(ent.plusEnabled, true, 'Within 7-day offline grace, Plus remains active');
  assert.equal(ent.state, 'active');
});

// 3. Token expired beyond grace followed by successful renewal
test('token expired beyond grace followed by successful renewal restores Plus', async () => {
  const nowSec = 1700000000;
  const nowMs = nowSec * 1000;
  const installId = 'inst_expired_1234567890';
  const serverAuthority = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubRaw = await crypto.subtle.exportKey('raw', serverAuthority.publicKey);
  const serverPubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));

  // Expired 15 days ago (> 7-day grace)
  const expired = await makeSignedToken({
    installId,
    iat: nowSec - 45 * 86400,
    exp: nowSec - 15 * 86400,
    keyPair: serverAuthority
  });

  // Step 1: Before server renewal, Plus is locked
  let ent = await resolveEntitlement({
    licenseRecord: { token: expired.token, state: 'active' },
    expectedInstallId: installId,
    publicKeyB64: serverPubKeyB64,
    nowMs
  });
  assert.equal(ent.plusEnabled, false);
  assert.equal(ent.state, 'expired');

  // Step 2: Server renewal provides fresh token
  const fresh = await makeSignedToken({
    installId,
    iat: nowSec,
    exp: nowSec + 30 * 86400,
    keyPair: serverAuthority
  });

  // Step 3: Verified fresh token unlocks Plus
  ent = await resolveEntitlement({
    licenseRecord: { token: fresh.token, state: 'active' },
    expectedInstallId: installId,
    publicKeyB64: serverPubKeyB64,
    nowMs: (nowSec + 60) * 1000
  });
  assert.equal(ent.plusEnabled, true);
  assert.equal(ent.state, 'active');
});

// 4. Copied token with mismatched install ID
test('copied token with mismatched install ID is rejected', async () => {
  const installA = 'inst_legit_user_1111111';
  const installB = 'inst_copied_user_2222222';

  const { token, pubB64 } = await makeSignedToken({ installId: installA });

  const verified = await verifyLicenseToken(token, {
    expectedInstallId: installB,
    publicKeyB64: pubB64
  });
  assert.equal(verified, null, 'Mismatched install ID must return null');

  const ent = await resolveEntitlement({
    licenseRecord: { token, state: 'active' },
    expectedInstallId: installB,
    publicKeyB64: pubB64
  });
  assert.equal(ent.plusEnabled, false, 'Copied token must not unlock Plus');
});
