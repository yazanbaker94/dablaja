import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlusMessageHandler } from '../src/shared/plus-messages.js';
import { createPlusDraftController } from '../src/shared/plus-draft-controller.js';
import { createBackup } from '../src/shared/plus-backup.js';
import { createDraft, appendCaption, finalizeDraft } from '../src/shared/plus-session.js';

const ENTITLED_SETTINGS = {
  entitlement: { plusEnabled: true, state: 'development_preview', label: 'نسخة تطوير Plus' },
  autosave: false,
  rememberVolumes: false,
  siteProfiles: []
};
const LOCKED_SETTINGS = {
  entitlement: { plusEnabled: false, state: 'locked', label: '' },
  autosave: false,
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
    get: () => settings,
    async setAutosave(v) { settings = { ...settings, autosave: v }; return settings; },
    async setRemember(v) { settings = { ...settings, rememberVolumes: v }; return settings; },
    async deleteProfile() { settings = { ...settings, siteProfiles: [] }; return settings; }
  };
  const handle = createPlusMessageHandler({
    controller,
    library,
    settings: settingsApi,
    entitlement: async () => settings
  });
  return { handle, controller, library, storage, db, getSettings: () => settings };
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
  ['PLUS_SET_AUTOSAVE', { value: true }],
  ['PLUS_SET_REMEMBER_VOLUMES', { value: true }],
  ['PLUS_DELETE_SITE_PROFILE', { origin: 'youtube.com' }],
  ['PLUS_UPDATE_NOTES', { sessionId: 'plussession_a1', notes: 'n' }],
  ['PLUS_DELETE_BOOKMARK', { sessionId: 'plussession_a1', bookmarkId: 'bmk_1' }],
  ['PLUS_UPDATE_BOOKMARK', { sessionId: 'plussession_a1', bookmarkId: 'bmk_1', note: 'n' }],
  ['PLUS_IMPORT_BACKUP', { rawBackup: '{}' }]
];

test('every paid mutation is rejected while locked and succeeds only when entitled', async () => {
  const locked = makeHandler({ entitled: false });
  for (const [type, payload] of PAID_MUTATIONS) {
    const result = await call(locked.handle, { type, ...payload });
    assert.equal(result.ok, false, `${type} must be rejected while locked`);
    assert.match(result.error.message, /Plus غير مفعّل/);
  }
  const entitled = makeHandler({ entitled: true });
  for (const [type, payload] of PAID_MUTATIONS) {
    const result = await call(entitled.handle, { type, ...payload });
    // Either succeeds or fails on business grounds (missing session etc.) —
    // but never with the locked error.
    if (result.ok === false) {
      assert.doesNotMatch(result.error.message, /Plus غير مفعّل/, type);
    }
  }
});

test('PLUS_GET_STATUS returns one consistent shape with full settings', async () => {
  const { handle } = makeHandler({ entitled: true });
  const response = await handle({ type: 'PLUS_GET_STATUS' });
  assert.equal(response.ok, true);
  assert.ok(response.plus.entitlement);
  assert.equal(typeof response.plus.autosave, 'boolean');
  assert.equal(typeof response.plus.rememberVolumes, 'boolean');
  assert.ok(Array.isArray(response.plus.siteProfiles));
  assert.equal(response.draft, null);
  assert.equal(response.storageWarning, null);
  // No bare entitlement object at the top level.
  assert.equal(response.plusEnabled, undefined);
});

test('autosave and per-site volume preferences round-trip through status', async () => {
  const { handle } = makeHandler({ entitled: true });
  let response = await handle({ type: 'PLUS_SET_AUTOSAVE', value: true });
  assert.equal(response.plus.autosave, true);
  response = await handle({ type: 'PLUS_SET_REMEMBER_VOLUMES', value: true });
  assert.equal(response.plus.rememberVolumes, true);
  response = await handle({ type: 'PLUS_GET_STATUS' });
  assert.equal(response.plus.autosave, true);
  assert.equal(response.plus.rememberVolumes, true);
  response = await handle({ type: 'PLUS_SET_AUTOSAVE', value: false });
  assert.equal(response.plus.autosave, false);
  response = await handle({ type: 'PLUS_SET_REMEMBER_VOLUMES', value: false });
  assert.equal(response.plus.rememberVolumes, false);
});

test('malformed or throwing entitlement providers default to locked', async () => {
  const storage = fakeStorage();
  const db = { async putSession(r) { return r; } };
  const controller = createPlusDraftController({ storage, db, getEntitlement: async () => { throw new Error('boom'); }, now: () => 1 });
  const handle = createPlusMessageHandler({
    controller,
    library: { async get() { return null; }, async list() { return []; }, async put(r) { return r; }, async delete() {}, async clear() {}, async putBatch() { return { written: 0, rejected: 0 }; } },
    settings: { async setAutosave() { throw new Error('x'); }, async setRemember() {}, async deleteProfile() {} },
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

test('unknown Plus messages return a structured error', async () => {
  const { handle } = makeHandler({ entitled: true });
  const response = await handle({ type: 'PLUS_NONSENSE' });
  assert.equal(response.ok, false);
});
