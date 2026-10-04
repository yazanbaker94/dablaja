import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryMessageHandler } from '../src/shared/library-messages.js';
import { createLibraryDraftController } from '../src/shared/library-draft-controller.js';
import { createBackup } from '../src/shared/library-backup.js';
import { createDraft, appendCaption, finalizeDraft } from '../src/shared/library-session.js';
import { upsertProfile } from '../src/shared/site-profiles.js';

const DEFAULT_SETTINGS = {
  rememberVolumes: false,
  localSavingEnabled: true,
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

function makeHandler() {
  let settings = structuredClone(DEFAULT_SETTINGS);
  const storage = fakeStorage();
  const db = { records: new Map(), async putSession(r) { const c = structuredClone(r); this.records.set(c.id, c); return c; } };
  const controller = createLibraryDraftController({
    storage,
    db,
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
    async setRemember(v) { settings = { ...settings, rememberVolumes: v }; return settings; },
    async deleteProfile() { settings = { ...settings, siteProfiles: [] }; return settings; },
    async updateProfile(origin, { originalVolume, dubbedVolume } = {}) {
      settings = { ...settings, siteProfiles: upsertProfile(settings.siteProfiles, { origin, originalVolume, dubbedVolume }) };
      return settings;
    }
  };
  const handle = createLibraryMessageHandler({
    controller,
    library,
    settings: settingsApi
  });
  return { handle, controller, library, storage, db, settingsApi, getSettings: () => settings };
}

async function call(handle, message) {
  try {
    return { ok: true, response: await handle(message) };
  } catch (error) {
    return { ok: false, error };
  }
}

test('LIBRARY_GET_STATUS returns one consistent shape with full settings', async () => {
  const { handle } = makeHandler();
  const response = await handle({ type: 'LIBRARY_GET_STATUS' });
  assert.equal(response.ok, true);
  assert.equal(response.librarySettings.entitlement, undefined, 'there is no paid tier to report');
  assert.equal(typeof response.librarySettings.rememberVolumes, 'boolean');
  assert.ok(Array.isArray(response.librarySettings.siteProfiles));
  assert.equal(response.draft, null);
  assert.equal(response.storageWarning, null);
  assert.equal(response.savedSessionCount, 0);
  assert.equal(response.plusEnabled, undefined);
});

test('LIBRARY_GET_STATUS reports the real saved-session count', async () => {
  const bundle = makeHandler();
  bundle.library.records.set('plussession_one', makeSession('plussession_one'));
  const response = await bundle.handle({ type: 'LIBRARY_GET_STATUS' });
  assert.equal(response.savedSessionCount, 1);
});

test('every completed session is saved as its own real record', async () => {
  const bundle = makeHandler();
  await bundle.controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  bundle.controller.caption({ channel: 'target', text: 'الجلسة الأولى', final: true });
  const first = await call(bundle.handle, { type: 'LIBRARY_SAVE_ACTIVE' });
  assert.equal(first.ok, true);
  const firstRecord = first.response.saved;
  bundle.library.records.set(firstRecord.id, structuredClone(firstRecord));

  await bundle.controller.finish({ autosave: false });
  await bundle.controller.start({ startedAt: 3000, siteOrigin: 'example.com' });
  bundle.controller.caption({ channel: 'target', text: 'الجلسة الثانية', final: true });
  const second = await call(bundle.handle, { type: 'LIBRARY_SAVE_ACTIVE' });
  assert.equal(second.ok, true);
  assert.ok(second.response.saved.id);
  assert.notEqual(second.response.saved.id, firstRecord.id);
});

test('saving the active session updates an already-saved record in place', async () => {
  const bundle = makeHandler();
  await bundle.controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  bundle.controller.caption({ channel: 'target', text: 'نص', final: true });
  const activeId = bundle.controller.status().active.id;
  bundle.library.records.set(activeId, makeSession(activeId, 'قديم'));
  const result = await call(bundle.handle, { type: 'LIBRARY_SAVE_ACTIVE' });
  assert.equal(result.ok, true);
  assert.equal(result.response.saved.id, activeId);
});

test('per-site volume preferences round-trip through status', async () => {
  const { handle } = makeHandler();
  let response = await handle({ type: 'LIBRARY_SET_REMEMBER_VOLUMES', value: true });
  assert.equal(response.librarySettings.rememberVolumes, true);
  response = await handle({ type: 'LIBRARY_GET_STATUS' });
  assert.equal(response.librarySettings.rememberVolumes, true);
  response = await handle({ type: 'LIBRARY_SET_REMEMBER_VOLUMES', value: false });
  assert.equal(response.librarySettings.rememberVolumes, false);
});

test('LIBRARY_UPDATE_SITE_PROFILE edits one level without clobbering the other', async () => {
  const { handle, getSettings } = makeHandler();
  getSettings().siteProfiles.push({ origin: 'youtube.com', originalVolume: 0.2, dubbedVolume: 1.1, updatedAt: 1 });

  let response = await handle({ type: 'LIBRARY_UPDATE_SITE_PROFILE', origin: 'youtube.com', originalVolume: 0.4, dubbedVolume: null });
  assert.equal(response.ok, true);
  let profile = response.librarySettings.siteProfiles.find((p) => p.origin === 'youtube.com');
  assert.equal(profile.originalVolume, 0.4);
  assert.equal(profile.dubbedVolume, 1.1, 'untouched level must be preserved');

  response = await handle({ type: 'LIBRARY_UPDATE_SITE_PROFILE', origin: 'youtube.com', originalVolume: null, dubbedVolume: 0.5 });
  profile = response.librarySettings.siteProfiles.find((p) => p.origin === 'youtube.com');
  assert.equal(profile.originalVolume, 0.4, 'untouched level must be preserved (reverse)');
  assert.equal(profile.dubbedVolume, 0.5);
});

test('a throwing settings provider falls back to default library settings', async () => {
  const storage = fakeStorage();
  const db = { async putSession(r) { return r; } };
  const controller = createLibraryDraftController({ storage, db, now: () => 1 });
  const handle = createLibraryMessageHandler({
    controller,
    library: { async get() { return null; }, async list() { return []; }, async put(r) { return r; }, async delete() {}, async clear() {}, async putBatch() { return { written: 0, rejected: 0 }; } },
    settings: { get: async () => { throw new Error('boom'); }, async setRemember() {}, async deleteProfile() {} }
  });
  const status = await handle({ type: 'LIBRARY_GET_STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.librarySettings.localSavingEnabled, true);
  assert.deepEqual(status.librarySettings.siteProfiles, []);
});

test('add bookmark returns the draft summary, not a nested status', async () => {
  const { handle, controller } = makeHandler();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  const response = await handle({ type: 'LIBRARY_ADD_BOOKMARK', note: 'علامة' });
  assert.equal(response.ok, true);
  assert.equal(response.draft.bookmarkCount, 1);
  assert.equal(typeof response.draft.id, 'string');
});

test('IDs and mutation inputs are validated centrally', async () => {
  const { handle, library } = makeHandler();
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  for (const bad of ['', null, 'x'.repeat(200), '../etc/passwd']) {
    const result = await call(handle, { type: 'LIBRARY_UPDATE_NOTES', sessionId: bad, notes: 'n' });
    assert.equal(result.ok, false, `sessionId ${JSON.stringify(bad)} must be rejected`);
  }
  const huge = 'ن'.repeat(50_000);
  const result = await call(handle, { type: 'LIBRARY_UPDATE_NOTES', sessionId: 'plussession_a1', notes: huge });
  assert.equal(result.ok, false, 'oversized notes rejected before touching the database');
});

test('notes update goes through the boundary and preserves multiline content', async () => {
  const { handle, library } = makeHandler();
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  const response = await handle({
    type: 'LIBRARY_UPDATE_NOTES',
    sessionId: 'plussession_a1',
    notes: 'سطر أول\nسطر ثانٍ\n\nفاصل'
  });
  assert.equal(response.ok, true);
  assert.equal(response.session.notes, 'سطر أول\nسطر ثانٍ\n\nفاصل');
});

test('import parses raw backup text at the worker boundary — renderer claims are ignored', async () => {
  const { handle, library } = makeHandler();
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  const backupText = createBackup([makeSession('plussession_new1')]);
  const response = await handle({ type: 'LIBRARY_IMPORT_BACKUP', rawBackup: backupText });
  assert.equal(response.ok, true);
  assert.equal(response.added, 1);
  assert.ok(library.records.has('plussession_new1'));

  // A renderer-forged "parsed" object without rawBackup fails validation.
  const forged = await call(handle, { type: 'LIBRARY_IMPORT_BACKUP', parsed: { ok: true, sessions: [makeSession('plussession_evil')] } });
  assert.equal(forged.ok, false);
  assert.ok(!library.records.has('plussession_evil'));

  // Tampered raw text is rejected by parseBackup inside the boundary.
  const tampered = await call(handle, { type: 'LIBRARY_IMPORT_BACKUP', rawBackup: '{"app":"other"}' });
  assert.equal(tampered.ok, false);
});

test('obsolete draft commands are rejected without touching owned data', async () => {
  const { handle, library } = makeHandler();
  library.records.set('plussession_a1', makeSession('plussession_a1'));
  const result = await call(handle, { type: 'PLUS_DISCARD_DRAFT', draftId: 'plussession_missing' });
  assert.equal(result.ok, true);
  assert.equal(result.response.ok, false);
  assert.equal(library.records.size, 1);
});

test('a session accepts more than one bookmark', async () => {
  const { handle, controller } = makeHandler();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  controller.caption({ channel: 'target', text: 'مرحباً', final: true });
  for (const note of ['لحظة أولى', 'لحظة ثانية', 'لحظة ثالثة']) {
    const result = await call(handle, { type: 'LIBRARY_ADD_BOOKMARK', note });
    assert.equal(result.ok, true);
  }
  assert.equal(controller.status().active.bookmarkCount, 3);
});

test('retired licensing messages are rejected', async () => {
  const { handle } = makeHandler();
  for (const type of ['PLUS_ACTIVATE_LICENSE', 'PLUS_START_CHECKOUT', 'PLUS_RECOVER_LICENSE']) {
    const response = await handle({ type, token: 'dpl1.a.b' });
    assert.equal(response.ok, false, `${type} must not be handled`);
  }
});

test('unknown library messages return a structured error', async () => {
  const { handle } = makeHandler();
  const response = await handle({ type: 'LIBRARY_NONSENSE' });
  assert.equal(response.ok, false);
});
