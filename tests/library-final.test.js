import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoteFlushController } from '../src/shared/note-flush.js';
import { createLibraryMessageHandler } from '../src/shared/library-messages.js';
import { createBackup } from '../src/shared/library-backup.js';
import { planBatchInsert } from '../src/shared/library-db.js';
import { LIBRARY_LIMITS, createDraft, appendCaption, finalizeDraft } from '../src/shared/library-session.js';

function session(id, updatedAt = 1000) {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  draft.id = id;
  appendCaption(draft, { channel: 'target', text: 'نص.', atMs: 1, final: true });
  const finished = finalizeDraft(draft, { endedAt: 100 });
  finished.updatedAt = updatedAt; // finalizeDraft stamps Date.now(); override after
  return finished;
}

// Capacity-aware in-memory library mirroring the real atomic batch layer.
function libraryWith(records) {
  return {
    records: new Map(records.map((record) => [record.id, record])),
    async get(id) { return this.records.get(id) || null; },
    async list() { return [...this.records.values()]; },
    async put(record) { this.records.set(record.id, record); return record; },
    async delete(id) { this.records.delete(id); },
    async clear() { this.records.clear(); },
    async putBatch(list) {
      const keys = [...this.records.keys()];
      const planned = planBatchInsert(list, keys, this.records.size, LIBRARY_LIMITS.MAX_SAVED_SESSIONS);
      for (const record of planned.admitted) this.records.set(record.id, record);
      return {
        written: planned.admitted.length,
        rejected: planned.rejected.length,
        writtenNew: planned.admittedNew.length,
        writtenUpdates: planned.admittedUpdates.length
      };
    }
  };
}

function handlerWith(library) {
  return createLibraryMessageHandler({
    controller: {
      status: () => ({ active: null, storageWarning: null }),
      bookmark: async () => {},
      save: async () => ({}),
      saveUnsaved: async () => ({}),
      discardUnsaved: async () => true
    },
    library,
    settings: {
      get: async () => ({ rememberVolumes: false, localSavingEnabled: true, siteProfiles: [] }),
      async setRemember() { return {}; },
      async deleteProfile() { return {}; }
    }
  });
}

// ---- 1. Note edits while a save is in flight --------------------------------

test('newer note edit survives an in-flight commit; flush drains both in order', async () => {
  const commits = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const flusher = createNoteFlushController({
    commit: async (id, value) => {
      commits.push([id, value]);
      if (commits.length === 1) {
        await firstGate; // first commit stays unresolved
        return true;
      }
      return true;
    },
    debounceMs: 5
  });
  flusher.schedule('plussession_a1', 'الأولى');
  await new Promise((r) => setTimeout(r, 20)); // first commit now in flight
  flusher.schedule('plussession_a1', 'الأحدث');
  await new Promise((r) => setTimeout(r, 30)); // debounce fires while in flight
  assert.equal(flusher.hasPending(), true, 'pending edit retained, not discarded');
  const flushed = flusher.flush();            // navigation awaits the drain
  releaseFirst();
  assert.equal(await flushed, true);
  assert.deepEqual(commits, [
    ['plussession_a1', 'الأولى'],
    ['plussession_a1', 'الأحدث']
  ], 'newer value committed exactly once after the in-flight commit');
});

test('failure of the second commit blocks navigation and retains the edit', async () => {
  const commits = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const flusher = createNoteFlushController({
    commit: async (id, value) => {
      calls += 1;
      commits.push([id, value]);
      if (calls === 1) {
        await firstGate;
        return true;
      }
      return false; // second commit fails
    },
    debounceMs: 5
  });
  flusher.schedule('plussession_a1', 'الأولى');
  await new Promise((r) => setTimeout(r, 20));
  flusher.schedule('plussession_a1', 'الفاشلة');
  const flushed = flusher.flush();
  releaseFirst();
  assert.equal(await flushed, false, 'navigation must see the failure');
  assert.ok(flusher.hasPending(), 'failed edit retained for retry');
});

// ---- 2. Truthful end-to-end import counts -----------------------------------

test('10 new sessions into a 495 library report added=5 rejected=5 updated=0', async () => {
  const existing = Array.from({ length: 495 }, (_, i) => session(`plussession_l${i}`));
  const imported = Array.from({ length: 10 }, (_, i) => session(`plussession_i${i}`));
  const library = libraryWith(existing);
  const handle = handlerWith(library);
  const response = await handle({ type: 'LIBRARY_IMPORT_BACKUP', rawBackup: createBackup(imported) });
  assert.equal(response.ok, true);
  assert.equal(response.added, 5, 'added = successfully written new records');
  assert.equal(response.rejected, 5, 'rejected = capacity-rejected records');
  assert.equal(response.updated, 0);
  assert.equal(library.records.size, 500);
});

test('full library: new records rejected, existing updates applied truthfully', async () => {
  const existing = Array.from({ length: 500 }, (_, i) => session(`plussession_f${i}`, 100));
  const newer = (id) => session(id, 9999);
  const imported = [newer('plussession_newX'), newer('plussession_f0')];
  const library = libraryWith(existing);
  const handle = handlerWith(library);
  const response = await handle({ type: 'LIBRARY_IMPORT_BACKUP', rawBackup: createBackup(imported) });
  assert.equal(response.ok, true);
  assert.equal(response.added, 0);
  assert.equal(response.rejected, 1, 'new record rejected at cap');
  assert.equal(response.updated, 1, 'existing update applied');
  assert.equal(library.records.size, 500);
  assert.equal(library.records.get('plussession_f0').updatedAt, 9999);
  assert.ok(!library.records.has('plussession_newX'));
});

test('duplicate imported IDs surface as superseded without double counting', async () => {
  const imported = [
    session('plussession_d1', 100),
    session('plussession_d1', 200), // superseded duplicate
    session('plussession_d2', 300)
  ];
  const library = libraryWith([]);
  const handle = handlerWith(library);
  const response = await handle({ type: 'LIBRARY_IMPORT_BACKUP', rawBackup: createBackup(imported) });
  assert.equal(response.ok, true);
  assert.equal(response.superseded, 1);
  assert.equal(response.added, 2);
  assert.equal(library.records.get('plussession_d1').updatedAt, 200, 'newest duplicate wins');
});

test('non-string rawBackup is rejected before parsing', async () => {
  const handle = handlerWith(libraryWith([]));
  for (const bad of [null, undefined, 42, { ok: true, sessions: [] }, ['x']]) {
    await assert.rejects(
      () => handle({ type: 'LIBRARY_IMPORT_BACKUP', rawBackup: bad }),
      /غير صالح/
    );
  }
});
