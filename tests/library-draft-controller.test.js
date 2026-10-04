import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryDraftController } from '../src/shared/library-draft-controller.js';

function harness({ failDb = 0, failStorage = false, delayMs = 0 } = {}) {
  let clock = 10_000;
  const store = new Map();
  const records = new Map();
  let putCalls = 0;
  const storage = {
    store,
    async get(key) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
    },
    async set(items) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failStorage) throw new Error('storage failed');
      for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value));
    },
    async remove(key) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      store.delete(key);
    }
  };
  const db = {
    records,
    async putSession(record) {
      putCalls += 1;
      if (failDb > 0) {
        failDb -= 1;
        throw new Error('idb failed');
      }
      const clean = structuredClone(record);
      records.set(clean.id, clean);
      return clean;
    },
    async getSession(id) { return records.get(id) || null; }
  };
  const controller = createLibraryDraftController({ storage, db, now: () => clock });
  return { controller, store, records, putCalls: () => putCalls, advance(ms) { clock += ms; } };
}

async function seed(controller, text = 'نص عربي.') {
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com', title: 'جلسة', pageUrl: 'https://youtube.com/watch?v=abc' });
  controller.caption({ channel: 'target', text, final: true });
}

test('active capture writes only an internal recovery snapshot', async () => {
  const h = harness();
  await seed(h.controller);
  await h.controller.bookmark({ note: 'لحظة' });
  assert.ok(h.store.has('plusActiveDraft'));
  assert.equal(h.store.has('plusUnsavedDrafts'), false);
  assert.equal(h.records.size, 0);
});

test('autosave writes a real library record', async () => {
  const h = harness();
  await seed(h.controller);
  const saved = await h.controller.finish({ autosave: true });
  assert.equal(saved.id.startsWith('plussession_'), true);
  assert.equal(h.records.size, 1);
  assert.equal(h.store.has('plusActiveDraft'), false);
  assert.equal(h.store.has('plusUnsavedDrafts'), false);
});

test('explicit save then more captions then stop updates one record', async () => {
  const h = harness();
  await seed(h.controller, 'الأول.');
  const first = await h.controller.save();
  h.advance(1000);
  h.controller.caption({ channel: 'target', text: 'الثاني.', final: true });
  await h.controller.bookmark({ note: 'مهم' });
  const final = await h.controller.finish({ autosave: true });
  assert.equal(final.id, first.id);
  assert.equal(h.records.size, 1);
  assert.ok(h.records.get(first.id).targetSegments.length >= 2);
  assert.equal(h.records.get(first.id).bookmarks.length, 1);
});

test('concurrent finish calls coalesce and write once', async () => {
  const h = harness({ delayMs: 2 });
  await seed(h.controller);
  const a = h.controller.finish({ autosave: true });
  const b = h.controller.finish({ autosave: true });
  assert.equal(a, b);
  await Promise.all([a, b]);
  assert.equal(h.putCalls(), 1);
  assert.equal(h.records.size, 1);
});

test('empty sessions are discarded and clear recovery state', async () => {
  const h = harness();
  await h.controller.start({ startedAt: 0, siteOrigin: 'example.com' });
  const result = await h.controller.finish({ autosave: true });
  assert.equal(result, null);
  assert.equal(h.records.size, 0);
  assert.equal(h.store.has('plusActiveDraft'), false);
});

test('startup recovery writes a real record and never creates a draft queue', async () => {
  const first = harness();
  await seed(first.controller);
  await first.controller.bookmark({ note: 'استرجاع' });
  const persisted = structuredClone(first.store.get('plusActiveDraft'));
  const second = harness();
  second.store.set('plusActiveDraft', persisted);
  const restored = await second.controller.restore();
  assert.equal(restored.id, persisted.id);
  assert.equal(second.records.size, 1);
  assert.equal(second.store.has('plusActiveDraft'), false);
  assert.equal(second.store.has('plusUnsavedDrafts'), false);
});

test('IndexedDB failure retains the newest recovery snapshot for retry', async () => {
  const h = harness({ failDb: 1 });
  await seed(h.controller);
  const result = await h.controller.finish({ autosave: true });
  assert.equal(result, null);
  assert.ok(h.store.has('plusActiveDraft'));
  assert.equal(h.records.size, 0);
});

test('late persistence from a finished session cannot resurrect active state', async () => {
  const h = harness({ delayMs: 3 });
  await seed(h.controller);
  h.controller.caption({ channel: 'target', text: 'تحديث متأخر', final: false });
  await h.controller.finish({ autosave: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.controller.status().active, null);
  assert.equal(h.store.has('plusActiveDraft'), false);
  assert.equal(h.records.size, 1);
});
