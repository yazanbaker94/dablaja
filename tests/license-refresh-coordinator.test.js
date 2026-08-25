import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntitlement,
  verifyLicenseToken,
  TOKEN_PREFIX,
  LICENSE_STATUS_URL,
  LICENSE_TOKEN_URL
} from '../src/shared/plus-entitlement.js';
import {
  createLicenseRefreshCoordinator,
  REFRESH_ALARM_NAME,
  REFRESH_INTERVAL_MINUTES,
  REFRESH_STALE_MS
} from '../src/shared/license-refresh-coordinator.js';
import { STORAGE_KEYS } from '../src/shared/constants.js';

const LIC_KEY = STORAGE_KEYS.PLUS_LICENSE;
const INST_ID = 'inst_coordinator_test_1';
const INST_CRED = 'c'.repeat(64);

// Deterministic Ed25519-signed dpl1 token factory (server stand-in).
async function makeSignedToken({
  licenseId = 'lic_test_123',
  installId = INST_ID,
  iat = Math.floor(Date.now() / 1000) - 3600,
  exp = Math.floor(Date.now() / 1000) + 30 * 86400,
  keyPair = null
} = {}) {
  const kp = keyPair || await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
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
  return `${TOKEN_PREFIX}.${payloadB64}.${sigB64}`;
}

async function exportPubB64(keyPair) {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

// In-memory storage adapter matching the coordinator's contract.
function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const alarmsState = { existing: [], created: [] };
  const storage = {
    store,
    failSet: false,
    setCalls: [],
    alarms: {
      getAll: async () => alarmsState.existing.slice(),
      create: async (name, opts) => {
        alarmsState.created.push({ name, opts });
        alarmsState.existing.push({ name, ...opts });
      }
    },
    async get(keys) {
      const out = {};
      for (const key of [].concat(keys)) out[key] = store.get(key);
      return out;
    },
    async set(items) {
      if (this.failSet) throw new Error('storage unavailable');
      this.setCalls.push(items);
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    }
  };
  return { storage, alarms: alarmsState };
}

// Per-test behavior knobs for the injected fetch double and clock.
let serverPub = null;
const behavior = { fetches: [], respond: null, nowMs: Date.now() };

function buildCoordinator(storage) {
  behavior.fetches = [];
  return createLicenseRefreshCoordinator({
    storage,
    identity: async () => ({ installId: INST_ID, installCredential: INST_CRED }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      behavior.fetches.push({ url: String(url), body });
      return behavior.respond ? behavior.respond(String(url), body) : null;
    },
    nowMs: () => behavior.nowMs,
    verifyToken: async (token, opts) =>
      verifyLicenseToken(token, {
        expectedInstallId: opts.expectedInstallId,
        nowMs: opts.nowMs,
        publicKeyB64: serverPub
      }),
    resolveEntitlementFn: async (opts) =>
      resolveEntitlement({ ...opts, publicKeyB64: serverPub })
  });
}

const okJson = (obj) => ({ ok: true, json: async () => obj });
const statusOk = () => okJson({ ok: true, status: 'active' });

test('active signed token: reconciliation persists verified fresh record and Plus unlocks', async () => {
  const nowSec = 1700000000;
  behavior.nowMs = nowMsOf(nowSec);
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);

  const oldToken = await makeSignedToken({ iat: nowSec - 7200, exp: nowSec + 30 * 86400, keyPair: kp });
  const fresh = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: oldToken, lastCheckedAt: (nowSec - 7200) * 1000 }
  });
  behavior.respond = (url, body) => {
    if (url === LICENSE_STATUS_URL) {
      assert.equal(body.install_id, INST_ID);
      assert.equal(body.install_credential, INST_CRED);
      assert.equal(body.token, oldToken);
      return statusOk();
    }
    assert.equal(url, LICENSE_TOKEN_URL);
    return okJson({ ok: true, token: fresh, licenseId: 'lic_test_123' });
  };
  const coordinator = buildCoordinator(storage);

  const result = await coordinator.reconcileLicenseWithServer();
  assert.equal(result.ok, true);
  assert.equal(result.renewed, true);

  const lic = storage.store.get(LIC_KEY);
  assert.equal(lic.token, fresh, 'fresh verified token persisted');
  assert.equal(lic.state, 'active');

  const ent = await resolveEntitlement({
    licenseRecord: lic,
    expectedInstallId: INST_ID,
    publicKeyB64: serverPub,
    nowMs: (nowSec + 30) * 1000
  });
  assert.equal(ent.plusEnabled, true);
});

test('grace token: authentic expired-within-grace token stays active; outage preserves it', async () => {
  const nowSec = 1700000000;
  behavior.nowMs = nowMsOf(nowSec);
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const graceInstall = 'inst_grace_123456789012';
  const grace = await makeSignedToken({ installId: graceInstall, iat: nowSec - 33 * 86400, exp: nowSec - 3 * 86400, keyPair: kp });

  // Pure offline resolution via the production resolver.
  const ent = await resolveEntitlement({
    licenseRecord: { state: 'active', token: grace },
    expectedInstallId: graceInstall,
    publicKeyB64: serverPub,
    nowMs: nowMsOf(nowSec)
  });
  assert.equal(ent.plusEnabled, true, 'within 7-day grace Plus stays active');
  assert.equal(ent.state, 'active');

  // A reconciliation attempt during an outage must not corrupt that record.
  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: grace, lastCheckedAt: (nowSec - 3 * 86400) * 1000 }
  });
  behavior.respond = () => null; // full network outage
  const coordinator = buildCoordinator(storage);
  const result = await coordinator.reconcileLicenseWithServer();
  assert.equal(result.ok, false, 'network outage reported as not-ok');
  assert.equal(storage.store.get(LIC_KEY).token, grace, 'offline grace record untouched');
});

test('authentic token expired beyond grace: outage keeps locked, later renewal restores', async () => {
  const nowSec = 1700000000;
  behavior.nowMs = nowMsOf(nowSec);
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);

  const expired = await makeSignedToken({ iat: nowSec - 45 * 86400, exp: nowSec - 15 * 86400, keyPair: kp });
  const fresh = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'expired', token: expired, lastCheckedAt: (nowSec - 15 * 86400) * 1000 }
  });
  let phase = 'outage';
  behavior.respond = (url) => {
    if (phase === 'outage') return null;
    return url === LICENSE_STATUS_URL ? statusOk() : okJson({ ok: true, token: fresh });
  };
  const coordinator = buildCoordinator(storage);

  const r1 = await coordinator.reconcileLicenseWithServer();
  assert.equal(r1.ok, false);
  let ent = await resolveEntitlement({
    licenseRecord: storage.store.get(LIC_KEY),
    expectedInstallId: INST_ID,
    publicKeyB64: serverPub,
    nowMs: nowMsOf(nowSec)
  });
  assert.equal(ent.plusEnabled, false, 'network failure keeps expired locked');
  assert.equal(storage.store.get(LIC_KEY).token, expired, 'token not deleted or falsified');

  phase = 'online';
  const r2 = await coordinator.reconcileLicenseWithServer();
  assert.equal(r2.ok, true);
  assert.equal(r2.renewed, true);
  ent = await resolveEntitlement({
    licenseRecord: storage.store.get(LIC_KEY),
    expectedInstallId: INST_ID,
    publicKeyB64: serverPub,
    nowMs: nowMsOf(nowSec + 10)
  });
  assert.equal(ent.plusEnabled, true, 'renewal restores Plus');
  assert.equal(storage.store.get(LIC_KEY).token, fresh);
});

function nowMsOf(sec) {
  return sec * 1000;
}

test('server revocation: local record flips to revoked and callback fires', async () => {
  const nowSec = 1700000000;
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const valid = await makeSignedToken({ iat: nowSec - 100, exp: nowSec + 30 * 86400, keyPair: kp });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: valid }
  });
  let revokedEvents = 0;
  behavior.respond = (url) => {
    if (url === LICENSE_STATUS_URL) return okJson({ ok: true, status: 'revoked' });
    throw new Error('token endpoint must not be called after revocation');
  };
  const coordinator = createLicenseRefreshCoordinator({
    storage,
    identity: async () => ({ installId: INST_ID, installCredential: INST_CRED }),
    fetchImpl: async (url, options) => {
      behavior.fetches.push({ url: String(url), body: JSON.parse(options.body) });
      return behavior.respond(String(url), JSON.parse(options.body));
    },
    verifyToken: async (token, opts) => verifyLicenseToken(token, { ...opts, publicKeyB64: serverPub }),
    resolveEntitlementFn: async (opts) => resolveEntitlement({ ...opts, publicKeyB64: serverPub }),
    onRevoked: async () => {
      revokedEvents += 1;
    }
  });

  const result = await coordinator.reconcileLicenseWithServer();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'revoked');
  assert.equal(revokedEvents, 1, 'revocation callback fired');

  const lic = storage.store.get(LIC_KEY);
  assert.equal(lic.state, 'revoked');

  const ent = await resolveEntitlement({
    licenseRecord: lic,
    expectedInstallId: INST_ID,
    publicKeyB64: serverPub,
    nowMs: nowMsOf(nowSec)
  });
  assert.equal(ent.plusEnabled, false);
  assert.equal(ent.state, 'revoked');
});

test('mismatched token installation: server token for another install never persists', async () => {
  const nowSec = 1700000000;
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const stolen = await makeSignedToken({ installId: 'inst_victim_9999999999', keyPair: kp });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: 'dpl1.previous.sig' }
  });
  behavior.respond = (url) => (url === LICENSE_STATUS_URL ? statusOk() : okJson({ ok: true, token: stolen }));
  const coordinator = buildCoordinator(storage);

  const result = await coordinator.reconcileLicenseWithServer();
  assert.equal(result.ok, true);
  assert.equal(result.renewed, false);
  assert.equal(result.invalid_signature, true, 'verification failed for foreign-install token');
  assert.equal(storage.store.get(LIC_KEY).token, 'dpl1.previous.sig', 'storage unchanged');
});

test('missing refresh alarm is recreated on startup check; existing alarm is kept', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  behavior.nowMs = Date.now();
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const realToken = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });
  const { storage, alarms } = makeStorage({
    [LIC_KEY]: { state: 'active', token: realToken, lastCheckedAt: Date.now(), verifiedAt: Date.now() }
  });
  behavior.respond = () => null;
  const coordinator = buildCoordinator(storage);

  const result = await coordinator.startupCheck();
  assert.equal(result.alarmCreated, true, 'alarm was recreated when missing');
  assert.equal(alarms.created.length, 1);
  assert.equal(alarms.created[0].name, REFRESH_ALARM_NAME);
  assert.equal(alarms.created[0].opts.periodInMinutes, REFRESH_INTERVAL_MINUTES);

  // Second run (worker restart simulation): alarm exists -> not re-created.
  const again = await coordinator.startupCheck();
  assert.equal(again.alarmCreated, false, 'no duplicate creation after restart');
  assert.equal(alarms.created.length, 1);
  // Fresh record: not stale, so no immediate reconciliation happened.
  assert.equal(again.reconciled, false);
});

test('worker restart with stale license recreates alarm AND immediately reconciles', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  behavior.nowMs = Date.now();
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const oldToken = await makeSignedToken({ iat: nowSec - 7200, exp: nowSec + 30 * 86400, keyPair: kp });
  const fresh = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });

  const staleTs = Date.now() - REFRESH_STALE_MS - 60_000;
  const { storage, alarms } = makeStorage({
    [LIC_KEY]: { state: 'active', token: oldToken, lastCheckedAt: staleTs, verifiedAt: staleTs }
  });
  behavior.respond = (url) => (url === LICENSE_STATUS_URL ? statusOk() : okJson({ ok: true, token: fresh }));
  const coordinator = buildCoordinator(storage);

  const result = await coordinator.startupCheck();
  assert.equal(result.alarmCreated, true);
  assert.equal(result.reconciled, true, 'stale license triggers immediate reconciliation');
  assert.equal(alarms.created.length, 1);
  assert.equal(storage.store.get(LIC_KEY).token, fresh);
});

test('forged/plain storage record does not create a refresh alarm', async () => {
  const nowSec = 1700000000;
  behavior.nowMs = nowMsOf(nowSec);
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const { storage, alarms } = makeStorage({
    [LIC_KEY]: { state: 'active', token: 'not-a-token', lastCheckedAt: Date.now() }
  });
  const coordinator = buildCoordinator(storage);
  const result = await coordinator.startupCheck();
  assert.equal(result.alarmCreated, false, 'forged record must not create alarm');
  assert.equal(alarms.created.length, 0);
});

test('startupCheck obtains real installation identity (installId) before entitlement check', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  behavior.nowMs = Date.now();
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const token = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });
  let askedIdentity = false;
  const { storage, alarms } = makeStorage({
    [LIC_KEY]: { state: 'active', token, lastCheckedAt: Date.now(), verifiedAt: Date.now() }
  });
  const coordinator = createLicenseRefreshCoordinator({
    storage,
    identity: async () => { askedIdentity = true; return { installId: INST_ID, installCredential: INST_CRED }; },
    fetchImpl: async () => null,
    nowMs: () => behavior.nowMs,
    verifyToken: async (t, opts) => verifyLicenseToken(t, { ...opts, publicKeyB64: serverPub }),
    resolveEntitlementFn: async (opts) => resolveEntitlement({ ...opts, publicKeyB64: serverPub })
  });
  await coordinator.startupCheck();
  assert.equal(askedIdentity, true, 'startupCheck must obtain identity');
  assert.equal(alarms.created.length, 1);
});

test('credential authentication bodies carry identity pair and current token', async () => {
  const nowSec = 1700000000;
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const fresh = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: 'dpl1.current.here' }
  });
  behavior.respond = (url) => (url === LICENSE_STATUS_URL ? statusOk() : okJson({ ok: true, token: fresh }));
  const coordinator = buildCoordinator(storage);

  await coordinator.reconcileLicenseWithServer();

  assert.equal(behavior.fetches.length, 2, 'status + token endpoints hit once each');
  for (const req of behavior.fetches) {
    assert.equal(req.body.install_id, INST_ID, 'install_id present');
    assert.match(req.body.install_credential, /^[0-9a-f]{64}$/, 'install_credential present');
    assert.equal(req.body.token, 'dpl1.current.here', 'current token forwarded');
    assert.equal(Object.keys(req.body).length, 3, 'exactly the three contract fields');
  }
});

test('concurrent refresh calls coalesce into one reconciliation window (2 requests total)', async () => {
  const nowSec = 1700000000;
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const fresh = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: kp });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: 'dpl1.concurrent.sig' }
  });
  behavior.respond = async (url) => {
    // Hold the window open long enough for all joiners to pile up.
    await new Promise((r) => setTimeout(r, 25));
    return url === LICENSE_STATUS_URL ? statusOk() : okJson({ ok: true, token: fresh });
  };
  const coordinator = buildCoordinator(storage);

  const results = await Promise.all([
    coordinator.reconcileLicenseWithServer(),
    coordinator.reconcileLicenseWithServer(),
    coordinator.reconcileLicenseWithServer(),
    coordinator.reconcileLicenseWithServer(),
    coordinator.reconcileLicenseWithServer()
  ]);

  const statusCalls = behavior.fetches.filter((f) => f.url === LICENSE_STATUS_URL).length;
  const tokenCalls = behavior.fetches.filter((f) => f.url === LICENSE_TOKEN_URL).length;
  assert.equal(statusCalls, 1, 'exactly one status request for 5 concurrent callers');
  assert.equal(tokenCalls, 1, 'exactly one token request');
  assert.equal(new Set(results.map((r) => r.callStamp ?? JSON.stringify(r))).size === 1, true);
  for (const r of results) {
    assert.deepEqual(r, results[0], 'every caller received the identical outcome');
  }
  assert.equal(coordinator.isReconciling(), false, 'window cleared afterwards');
});

test('storage failure during revocation rejects the shared promise; later retry succeeds', async () => {
  const nowSec = 1700000000;
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);

  const { storage, alarms } = makeStorage({
    [LIC_KEY]: { state: 'active', token: 'dpl1.revokeme.sig' }
  });
  storage.failSet = true;
  behavior.respond = (url) => (url === LICENSE_STATUS_URL ? okJson({ ok: true, status: 'revoked' }) : null);

  const coordinator = buildCoordinator(storage);
  const pending = [
    coordinator.reconcileLicenseWithServer(),
    coordinator.reconcileLicenseWithServer(),
    coordinator.reconcileLicenseWithServer()
  ];
  const outcomes = await Promise.allSettled(pending);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected', 'every joined caller rejected');
    assert.match(String(outcome.reason?.message), /storage unavailable/);
  }

  // Retry after failure is possible because the in-flight window cleared.
  storage.failSet = false;
  behavior.respond = (url) => (url === LICENSE_STATUS_URL ? okJson({ ok: true, status: 'revoked' }) : null);
  const retry = await coordinator.reconcileLicenseWithServer();
  assert.equal(retry.ok, true);
  assert.equal(retry.status, 'revoked');
  assert.equal(storage.store.get(LIC_KEY).state, 'revoked');
});

test('malformed server JSON: treated as failed reconciliation, storage untouched', async () => {
  const nowSec = 1700000000;
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(kp);
  const before = { state: 'active', token: 'dpl1.keepme.sig' };

  const { storage } = makeStorage({ [LIC_KEY]: before });
  behavior.respond = (url) => {
    if (url !== LICENSE_STATUS_URL) throw new Error('must not reach token endpoint');
    return {
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      }
    };
  };
  const coordinator = buildCoordinator(storage);
  const result = await coordinator.reconcileLicenseWithServer();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed_json');
  assert.deepEqual(storage.store.get(LIC_KEY), before, 'record untouched');
});

test('invalid newly returned signature: rejected, nothing persisted', async () => {
  const nowSec = 1700000000;
  const attacker = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const honest = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  serverPub = await exportPubB64(honest); // extension trusts THIS key
  const forged = await makeSignedToken({ iat: nowSec - 60, exp: nowSec + 30 * 86400, keyPair: attacker });

  const { storage } = makeStorage({
    [LIC_KEY]: { state: 'active', token: 'dpl1.original.sig' }
  });
  behavior.respond = (url) => (url === LICENSE_STATUS_URL ? statusOk() : okJson({ ok: true, token: forged }));
  const coordinator = buildCoordinator(storage);

  const result = await coordinator.reconcileLicenseWithServer();
  assert.equal(result.renewed, false);
  assert.equal(result.invalid_signature, true, 'forged signature detected');
  assert.equal(storage.store.get(LIC_KEY).token, 'dpl1.original.sig', 'forged token never persisted');
});
