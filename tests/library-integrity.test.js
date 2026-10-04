import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryDraftController } from '../src/shared/library-draft-controller.js';
import { MAX_BACKUP_BYTES, parseBackup } from '../src/shared/library-backup.js';
import { planBatchInsert } from '../src/shared/library-db.js';
import { appendCaption, createDraft, finalizeDraft } from '../src/shared/library-session.js';

function makeRecord(id, updatedAt = 1) {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  draft.id = id;
  appendCaption(draft, { channel: 'target', text: 'نص.', atMs: 100, final: true });
  const record = finalizeDraft(draft, { endedAt: 1000 });
  record.updatedAt = updatedAt;
  return record;
}

test('500-record admission plan accepts only available new slots while allowing updates', () => {
  const existing = Array.from({ length: 499 }, (_, index) => makeRecord(`plussession_e${index}`));
  const incoming = [makeRecord('plussession_new1'), makeRecord('plussession_new2'), makeRecord('plussession_e10', 999)];
  const plan = planBatchInsert(incoming, existing.map((record) => record.id), existing.length);
  assert.equal(plan.admittedNew.length, 1);
  assert.equal(plan.admittedUpdates.length, 1);
  assert.equal(plan.rejected.length, 1);
});

test('backup parser enforces UTF-8 byte limits rather than character count', () => {
  const oversized = JSON.stringify({ kind: 'dablaja-plus-backup', version: 1, sessions: [], padding: 'ع'.repeat(MAX_BACKUP_BYTES) });
  assert.equal(parseBackup(oversized).ok, false);
});

test('recovery removal happens only after the database write succeeds', async () => {
  const events = [];
  const map = new Map();
  const storage = {
    async get(key) { return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}; },
    async set(items) { for (const [key, value] of Object.entries(items)) { events.push(`set:${key}`); map.set(key, structuredClone(value)); } },
    async remove(key) { events.push(`remove:${key}`); map.delete(key); }
  };
  const db = { async putSession(record) { events.push('db:put'); return structuredClone(record); }, async getSession() { return null; } };
  const controller = createLibraryDraftController({ storage, db, now: () => 1000 });
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  controller.caption({ channel: 'target', text: 'نص.', final: true });
  await controller.finish({ autosave: true });
  assert.ok(events.lastIndexOf('db:put') < events.lastIndexOf('remove:plusActiveDraft'));
});

test('recovery failure never fabricates an unsaved-draft list', async () => {
  const record = makeRecord('plussession_recover');
  const map = new Map([['plusActiveDraft', record]]);
  const storage = {
    async get(key) { return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}; },
    async set(items) { for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); }
  };
  const db = { async putSession() { throw new Error('idb down'); }, async getSession() { return null; } };
  const controller = createLibraryDraftController({ storage, db, now: () => 1000 });
  assert.equal(await controller.restore(), null);
  assert.ok(map.has('plusActiveDraft'));
  assert.equal(map.has('plusUnsavedDrafts'), false);
});
