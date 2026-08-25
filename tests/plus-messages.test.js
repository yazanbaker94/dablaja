import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlusMessageHandler } from '../src/shared/plus-messages.js';
import { createPlusDraftController } from '../src/shared/plus-draft-controller.js';
import { createBackup } from '../src/shared/plus-backup.js';
import { createDraft, appendCaption, finalizeDraft } from '../src/shared/plus-session.js';
import { upsertProfile } from '../src/shared/site-profiles.js';

const ENTITLED_SETTINGS = {
  entitlement: { plusEnabled: true, state: 'development_preview', label: 'نسخة تطوير Plus' },
  rememberVolumes: false,
  siteProfiles: []
};
const LOCKED_SETTINGS = {
  entitlement: { plusEnabled: false, state: 'locked', label: '' },
  rememberVolumes: false,
  siteProfiles: []
};

function fakeStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? { [k]: structuredClone(map.get(k)) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) map.set(k, structuredClone(v)); },
    async remove(k) { map.delete(k); }
  };
}

function makeSession(id, text = 'نص.') {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  draft.id = id;
  appendCaption(draft, { channel: 'target', text, atMs: 100, final: true });
  return finalizeDraft(draft, { endedAt: 2000 });
}

function makeHandler({ entitled = true } = {}) {
  let settings = structuredClone(entitled ? ENTITLED_SETTINGS : LOCKED_SETTINGS);
  const storage = fakeStorage();
  const db = { records: new Map(), async putSession(r) { const c = structuredClone(r); this.records.set(c.id, c); return c; } };
  const controller = createPlusDraftController({
    storage,
    db,
    getEntitlement: async () => settings.entitlement,
    now: () => 1000
  });
  const library = {
    records: new Map(),
    async get(id) { return this.records.get(id) || null; },
    async list() { return [...this.records.values()]; },
    async put(record) { this.records.set(record.id, structuredClone(record)); return record; },
    async delete(id) { this.records.delete(id); },
    async clear() { this.records.clear(); },
    async putBatch(list) {
      const existingAtStart = new Set(this.records.keys());
      let writtenNew = 0;
      let writtenUpdates = 0;
      for (const record of list) {
        if (existingAtStart.has(record.id)) writtenUpdates += 1;
        else writtenNew += 1;
        this.records.set(record.id, structuredClone(record));
      }
      return { written: writtenNew + writtenUpdates, rejected: 0, writtenNew, writtenUpdates };
    }
  };
  const settingsApi = {
    stored: null,
    get: () => settings,
    async setLicense(record) { settingsApi.stored = structuredClone(record); settings = { ...settings, entitlement: { plusEnabled: Boolean(record), state: record ? 'active' : 'locked' } }; return settings; },
        async setRemember(v) { settings = { ...settings, rememberVolumes: v }; return settings; },
    async deleteProfile() { settings = { ...settings, siteProfiles: [] }; return settings; },
    async updateProfile(origin, { originalVolume, dubbedVolume } = {}) {
      settings = { ...settings, siteProfiles: upsertProfile(settings.siteProfiles, { origin, originalVolume, dubbedVolume }) };
      return settings;
    }
  };
  const handle = createPlusMessageHandler({
    controller,
    library,
    settings: settingsApi,
    entitlement: async () => settings
  });
  return { handle, controller, library, storage, db, settingsApi, getSettings: () => settings };
}

// Same as makeHandler but with a test Ed25519 public key injected for token
// verification (mirrors the production tokenPublicKey parameter).
function makeTokenHandler(publicKeyB64) {
  const bundle = makeHandler({ entitled: false });
  const handle = createPlusMessageHandler({
    controller: bundle.controller,
    library: bundle.library,
    settings: bundle.settingsApi,
    entitlement: async () => bundle.getSettings(),
    tokenPublicKey: publicKeyB64
  });
  return { ...bundle, handle };
}

async function call(handle, message) {
  try {
    return { ok: true, response: await handle(message) };
  } catch (error) {
    return { ok: false, error };
  }
}

const PAID_MUTATIONS = [
  ['PLUS_SAVE_ACTIVE', {}],
  ['PLUS_SAVE_UNSAVED', { draftId: 'plussession_a1' }],
  ['PLUS_ADD_BOOKMARK', { note: 'x' }],
  ['PLUS_SET_REMEMBER_VOLUMES', { value: true }],
  ['PLUS_DELETE_SITE_PROFILE', { origin: 'youtube.com' }],
  ['PLUS_UPDATE_SITE_PROFILE', { origin: 'youtube.com', originalVolume: 0.4, dubbedVolume: null }],
  ['PLUS_UPDATE_NOTES', { sessionId: 'plussession_a1', notes: 'n' }],
  ['PLUS_DELETE_BOOKMARK', { sessionId: 'plussession_a1', bookmarkId: 'bmk_1' }],
  ['PLUS_UPDATE_BOOKMARK', { sessionId: 'plussession_a1', bookmarkId: 'bmk_1', note: 'n' }],
  ['PLUS_IMPORT_BACKUP', { rawBackup: '{}' }]
];

test('PLUS_IMPORT_BACKUP is Plus-only', async () => {
  const freeHandler = makeHandler({ entitled: false });
  // Backup import is Plus-only
  const importResult = await call(freeHandler.handle, { type: 'PLUS_IMPORT_BACKUP', rawBackup: '{}' });
  assert.equal(importResult.ok, false);
  assert.match(importResult.error.message, /Plus غير مفعّل/);
});

test('PLUS_GET_STATUS returns one consistent shape with full settings', async () => {
  const { handle } = makeHandler({ entitled: true });
  const response = await handle({ type: 'PLUS_GET_STATUS' });
  assert.equal(response.ok, true);
  assert.ok(response.plus.entitlement);
  assert.equal(typeof response.plus.rememberVolumes, 'boolean');
  assert.ok(Array.isArray(response.plus.siteProfiles));
  assert.equal(response.draft, null);
  assert.equal(response.storageWarning, null);
  // No bare entitlement object at the top level.
  assert.equal(response.plusEnabled, undefined);
});

test('free tier may save one session, then receives an actionable upgrade error', async () => {
  const bundle = makeHandler({ entitled: false });
  await bundle.controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  bundle.controller.caption({ channel: 'target', text: 'الجلسة الأولى', final: true });
  const first = await call(bundle.handle, { type: 'PLUS_SAVE_ACTIVE' });
  assert.equal(first.ok, true);
  const firstRecord = first.response.saved;
  bundle.library.records.set(firstRecord.id, structuredClone(firstRecord));

  await bundle.controller.finish({ autosave: false });
  await bundle.controller.start({ startedAt: 3000, siteOrigin: 'example.com' });
  bundle.controller.caption({ channel: 'target', text: 'الجلسة الثانية', final: true });
  const second = await call(bundle.handle, { type: 'PLUS_SAVE_ACTIVE' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'upgrade_required');
  assert.match(second.error.message, /جلسة واحدة/);
});

test('free-tier capacity guard allows updating the same already-owned record', async () => {
  const bundle = makeHandler({ entitled: false });
  await bundle.controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  bundle.controller.caption({ channel: 'target', text: 'نص', final: true });
  const activeId = bundle.controller.status().active.id;
  bundle.library.records.set(activeId, makeSession(activeId, 'قديم'));
  const result = await call(bundle.handle, { type: 'PLUS_SAVE_ACTIVE' });
  assert.equal(result.ok, true);
  assert.equal(result.response.saved.id, activeId);
});

test('per-site volume preferences round-trip through status', async () => {
  const { handle } = makeHandler({ entitled: true });
  let response = await handle({ type: 'PLUS_SET_REMEMBER_VOLUMES', value: true });
  assert.equal(response.plus.rememberVolumes, true);
  response = await handle({ type: 'PLUS_GET_STATUS' });
  assert.equal(response.plus.rememberVolumes, true);
  response = await handle({ type: 'PLUS_SET_REMEMBER_VOLUMES', value: false });
  assert.equal(response.plus.rememberVolumes, false);
});

test('PLUS_UPDATE_SITE_PROFILE edits one level without clobbering the other', async () => {
  const { handle, getSettings } = makeHandler({ entitled: true });
  getSettings().siteProfiles.push({ origin: 'youtube.com', originalVolume: 0.2, dubbedVolume: 1.1, updatedAt: 1 });

  let response = await handle({ type: 'PLUS_UPDATE_SITE_PROFILE', origin: 'youtube.com', originalVolume: 0.4, dubbedVolume: null });
  assert.equal(response.ok, true);
  let profile = response.plus.siteProfiles.find((p) => p.origin === 'youtube.com');
  assert.equal(profile.originalVolume, 0.4);
  assert.equal(profile.dubbedVolume, 1.1, 'untouched level must be preserved');

  response = await handle({ type: 'PLUS_UPDATE_SITE_PROFILE', origin: 'youtube.com', originalVolume: null, dubbedVolume: 0.5 });
  profile = response.plus.siteProfiles.find((p) => p.origin === 'youtube.com');
  assert.equal(profile.originalVolume, 0.4, 'untouched level must be preserved (reverse)');
  assert.equal(profile.dubbedVolume, 0.5);
});

test('malformed or throwing entitlement providers default to locked', async () => {
  const storage = fakeStorage();
  const db = { async putSession(r) { return r; } };
  const controller = createPlusDraftController({ storage, db, getEntitlement: async () => { throw new Error('boom'); }, now: () => 1 });
  const handle = createPlusMessageHandler({
    controller,
    library: { async get() { return null; }, async list() { return []; }, async put(r) { return r; }, async delete() {}, async clear() {}, async putBatch() { return { written: 0, rejected: 0 }; } },
    settings: { async setRemember() {}, async deleteProfile() {} },
    entitlement: async () => { throw new Error('boom'); }
  });
  const result = await call(handle, { type: 'PLUS_ADD_BOOKMARK', note: 'x' });
  assert.equal(result.ok, false);
  const status = await handle({ type: 'PLUS_GET_STATUS' });
  assert.equal(status.plus.entitlement.plusEnabled, false);
});

test('add bookmark returns the draft summary, not a nested status', async () => {
  const { handle, controller } = makeHandler({ entitled: true });
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  const response = await handle({ type: 'PLUS_ADD_BOOKMARK', note: 'علامة' });
  assert.equal(response.ok, true);
  assert.equal(response.draft.bookmarkCount, 1);
  assert.equal(typeof response.draft.id, 'string');
});

test('IDs and mutation inputs are validated centrally', async () => {
  const { handle, library } = makeHandler({ entitled: true });
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  for (const bad of ['', null, 'x'.repeat(200), '../etc/passwd']) {
    const result = await call(handle, { type: 'PLUS_UPDATE_NOTES', sessionId: bad, notes: 'n' });
    assert.equal(result.ok, false, `sessionId ${JSON.stringify(bad)} must be rejected`);
  }
  const huge = 'ن'.repeat(50_000);
  const result = await call(handle, { type: 'PLUS_UPDATE_NOTES', sessionId: 'plussession_a1', notes: huge });
  assert.equal(result.ok, false, 'oversized notes rejected before touching the database');
});

test('notes update goes through the boundary and preserves multiline content', async () => {
  const { handle, library } = makeHandler({ entitled: true });
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  const response = await handle({
    type: 'PLUS_UPDATE_NOTES',
    sessionId: 'plussession_a1',
    notes: 'سطر أول\nسطر ثانٍ\n\nفاصل'
  });
  assert.equal(response.ok, true);
  assert.equal(response.session.notes, 'سطر أول\nسطر ثانٍ\n\nفاصل');
});

test('import parses raw backup text at the worker boundary — renderer claims are ignored', async () => {
  const { handle, library } = makeHandler({ entitled: true });
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  const backupText = createBackup([makeSession('plussession_new1')]);
  const response = await handle({ type: 'PLUS_IMPORT_BACKUP', rawBackup: backupText });
  assert.equal(response.ok, true);
  assert.equal(response.added, 1);
  assert.ok(library.records.has('plussession_new1'));

  // A renderer-forged "parsed" object without rawBackup fails validation.
  const forged = await call(handle, { type: 'PLUS_IMPORT_BACKUP', parsed: { ok: true, sessions: [makeSession('plussession_evil')] } });
  assert.equal(forged.ok, false);
  assert.ok(!library.records.has('plussession_evil'));

  // Tampered raw text is rejected by parseBackup inside the boundary.
  const tampered = await call(handle, { type: 'PLUS_IMPORT_BACKUP', rawBackup: '{"app":"other"}' });
  assert.equal(tampered.ok, false);
});

test('locked users keep read/export/delete access to owned data', async () => {
  const { handle, library } = makeHandler({ entitled: false });
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  // These stay direct/local in the library page; the boundary exposes the
  // draft-discard path which remains allowed while locked.
  const result = await call(handle, { type: 'PLUS_DISCARD_DRAFT', draftId: 'plussession_missing' });
  // Discarding a missing draft simply no-ops (owned-data path, not paid).
  assert.equal(result.ok, true);
  assert.equal(library.records.size, 1);
});

test('free tier allows 1 bookmark and gates second bookmark with upgrade prompt', async () => {
  const { handle, controller } = makeHandler({ entitled: false });
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  controller.caption({ channel: 'target', text: 'مرحباً', final: true });

  // 1st bookmark on free tier succeeds
  const firstBm = await call(handle, { type: 'PLUS_ADD_BOOKMARK', note: 'لحظة أولى' });
  assert.equal(firstBm.ok, true);
  assert.equal(controller.status().active.bookmarkCount, 1);

  // 2nd bookmark on free tier fails with upgrade prompt
  const secondBm = await call(handle, { type: 'PLUS_ADD_BOOKMARK', note: 'لحظة ثانية' });
  assert.equal(secondBm.ok, false);
  assert.match(secondBm.error.message, /الخطة المجانية تتيح حفظ لحظة واحدة/);
  assert.equal(secondBm.error.code, 'upgrade_required');
});

test('PLUS_ACTIVATE_LICENSE verifies and stores license records', async () => {
  const signer = await makeSigner();
  const { handle } = makeTokenHandler(signer.publicKeyB64);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await signToken(signer, { lid: 'user@example.com', iid: 'install-12345678901234', iat: nowSeconds - 10, exp: nowSeconds + 86400 });
  const response = await handle({ type: 'PLUS_ACTIVATE_LICENSE', token });
  assert.equal(response.ok, true);
});

test('PLUS_ACTIVATE_LICENSE rejects forged or malformed license records', async () => {
  const { handle } = makeHandler({ entitled: false });
  const forgeries = [
    { state: 'active' },
    { state: 'active', verifiedAt: Date.now(), verifier: 'entitlement_endpoint' },
    { state: 'active', verifiedAt: -5, verifier: 'entitlement_endpoint', licenseId: 'x' },
    { state: 'active', verifiedAt: Date.now(), verifier: 'hand-written', licenseId: 'x' },
    'plussession_active',
    null
  ];
  for (const forgery of forgeries) {
    await assert.rejects(
      () => handle({ type: 'PLUS_ACTIVATE_LICENSE', license: forgery }),
      /سجل الترخيص غير صالح/,
      `must reject ${JSON.stringify(forgery)}`
    );
  }
});

// ---- Signed-token activation (Ed25519) --------------------------------------

const webcrypto = globalThis.crypto;
const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeSigner() {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    privateKey: keyPair.privateKey,
    publicKeyB64: bytesToBase64(new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey)))
  };
}

// Builds a dpl1 token exactly as the server does: Ed25519 over b"dpl1."+rawJSON.
async function signToken(signer, payload, { corruptSignature = false } = {}) {
  const raw = encoder.encode(JSON.stringify(payload));
  const prefix = encoder.encode('dpl1.');
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix, 0);
  signed.set(raw, prefix.length);
  const signature = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, signer.privateKey, signed));
  if (corruptSignature) signature[0] ^= 0xff;
  return `dpl1.${bytesToBase64Url(raw)}.${bytesToBase64Url(signature)}`;
}

test('PLUS_ACTIVATE_LICENSE accepts a correctly signed token and stores the verified record', async () => {
  const signer = await makeSigner();
  const { handle, settingsApi } = makeTokenHandler(signer.publicKeyB64);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await signToken(signer, {
    lid: 'buyer@example.com',
    iid: 'install-abcdef1234567890',
    iat: nowSeconds - 60,
    exp: nowSeconds + 86400
  });
  const result = await call(handle, { type: 'PLUS_ACTIVATE_LICENSE', token });
  assert.equal(result.ok, true);
  assert.equal(result.response.plus.entitlement.plusEnabled, true);
  assert.equal(settingsApi.stored?.verifier, 'signed_token');
  assert.equal(settingsApi.stored?.licenseId, 'buyer@example.com');
});

test('PLUS_ACTIVATE_LICENSE rejects tokens with a bad signature or tampered payload', async () => {
  const signer = await makeSigner();
  const { handle } = makeTokenHandler(signer.publicKeyB64);
  const futureSeconds = Math.floor(Date.now() / 1000) + 86400;
  const validPayload = { lid: 'a@b.c', iid: 'i-12345678901234', iat: 1, exp: futureSeconds };

  // Corrupted signature over an otherwise valid payload.
  const badSig = await signToken(signer, validPayload, { corruptSignature: true });
  let result = await call(handle, { type: 'PLUS_ACTIVATE_LICENSE', token: badSig });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /رمز الترخيص غير صالح/);

  // Valid signature from OUR key, but the payload was swapped after signing.
  const tamperedRaw = bytesToBase64Url(encoder.encode(JSON.stringify({ ...validPayload, lid: 'attacker@example.com' })));
  const goodSigForOtherPayload = (await signToken(signer, validPayload)).split('.')[2];
  result = await call(handle, {
    type: 'PLUS_ACTIVATE_LICENSE',
    token: `dpl1.${tamperedRaw}.${goodSigForOtherPayload}`
  });
  assert.equal(result.ok, false);

  for (const junk of ['not-a-token', 'jwt2.abc.def', `dpl1.${'A'.repeat(20)}`]) {
    result = await call(handle, { type: 'PLUS_ACTIVATE_LICENSE', token: junk });
    assert.equal(result.ok, false, `must reject ${junk}`);
  }
});

test('PLUS_ACTIVATE_LICENSE rejects expired tokens; missing key fails closed', async () => {
  const signer = await makeSigner();
  const pastExp = Math.floor(Date.now() / 1000) - 10;
  const expired = await signToken(signer, { lid: 'a@b.c', iid: 'i-12345678901234', iat: 1, exp: pastExp });

  const withKey = makeTokenHandler(signer.publicKeyB64);
  const rejected = await call(withKey.handle, { type: 'PLUS_ACTIVATE_LICENSE', token: expired });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /رمز الترخيص غير صالح/);

  // Empty embedded/injected public key → verification fails closed.
  const noKey = makeTokenHandler('');
  const forged = `dpl1.${bytesToBase64Url(encoder.encode(JSON.stringify({ lid: 'x@y.z', exp: pastExp + 99999 })))}.${'A'.repeat(86)}`;
  const closedResult = await call(noKey.handle, { type: 'PLUS_ACTIVATE_LICENSE', token: forged });
  assert.equal(closedResult.ok, false);
});

test('verifyLicenseToken round-trips a server-shaped token directly', async () => {
  const { verifyLicenseToken } = await import('../src/shared/plus-entitlement.js');
  const signer = await makeSigner();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await signToken(signer, { lid: 'direct@example.com', iid: 'i', iat: nowSeconds, exp: nowSeconds + 3600 });
  const verified = await verifyLicenseToken(token, { publicKeyB64: signer.publicKeyB64 });
  assert.equal(verified?.state, 'active');
  assert.equal(verified?.verifier, 'signed_token');
  assert.equal(verified?.licenseId, 'direct@example.com');
  assert.equal(await verifyLicenseToken(token, { publicKeyB64: '' }), null);
});

test('unknown Plus messages return a structured error', async () => {
  const { handle } = makeHandler({ entitled: true });
  const response = await handle({ type: 'PLUS_NONSENSE' });
  assert.equal(response.ok, false);
});
