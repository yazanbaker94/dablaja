import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlusDraftController } from '../src/shared/plus-draft-controller.js';

// The controller's entitlement provider returns the entitlement object
// itself — mirroring the SW wiring `() => (await getPlusSettings()).entitlement`.
const ENTITLED = { plusEnabled: true, state: 'development_preview' };
const LOCKED = { plusEnabled: false, state: 'locked' };

function fakeStorage({ delayMs = 0, failWrites = false } = {}) {
  const store = new Map();
  return {
    store,
    writes: [],
    async get(key) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
    },
    async set(items) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failWrites) throw new Error('quota');
      for (const [key, value] of Object.entries(items)) {
        store.set(key, structuredClone(value));
        this.writes.push(key);
      }
    },
    async remove(key) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      store.delete(key);
    }
  };
}

function fakeDb() {
  const records = new Map();
  return {
    records,
    failures: 0,
    async putSession(record) {
      if (this.failures > 0) {
        this.failures -= 1;
        throw new Error('idb write failed');
      }
      const clean = structuredClone(record);
      this.records.set(clean.id, clean);
      return clean;
    }
  };
}

function makeController({ entitlement = ENTITLED, storageOptions = {}, db = fakeDb() } = {}) {
  let entitlementState = entitlement;
  let clock = 10_000;
  const storage = fakeStorage(storageOptions);
  const controller = createPlusDraftController({
    storage,
    db,
    getEntitlement: async () => entitlementState,
    now: () => clock
  });
  return {
    controller,
    storage,
    db,
    advanceClock: (ms) => {
      clock += ms;
    },
    setEntitlement: (next) => {
      entitlementState = next;
    }
  };
}

const caption = (c, channel, text, final = false) => c.caption({ channel, text, final });

test('free tier users capture active draft for their trial session', async () => {
  const { controller, storage } = makeController({ entitlement: LOCKED });
  const started = await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  assert.ok(started.id.startsWith('plussession_'));
  caption(controller, 'target', 'نص.', true);
  await controller.finish({});
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1);
});

test('entitlement is checked before capture; drafts persist for entitled users', async () => {
  const { controller, storage } = makeController();
  const started = await controller.start({ startedAt: 0, siteOrigin: 'https://youtube.com/watch?v=x', title: 'فيديو', pageUrl: 'https://youtube.com/watch?v=x' });
  assert.ok(started.id.startsWith('plussession_'));
  caption(controller, 'source', 'Hello.', true);
  await controller.save({});
  assert.equal(storage.store.get('plusActiveDraft').saveRequested, true);
});

test('mid-session save → continue captions → later bookmark → stop = ONE complete record', async () => {
  const { controller, db } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'source', 'First.', true);
  await controller.save({});
  assert.equal(db.records.size, 1);
  const savedId = [...db.records.keys()][0];
  caption(controller, 'target', 'جديد بعد الحفظ.', true);
  await controller.bookmark({ note: 'لاحقاً' });
  await controller.finish({ autosave: false });
  assert.equal(db.records.size, 1, 'no duplicate record');
  const record = db.records.get(savedId);
  assert.equal(record.sourceSegments.length, 1);
  assert.equal(record.targetSegments.length, 1);
  assert.equal(record.bookmarks.length, 1);
  assert.equal(record.bookmarks[0].note, 'لاحقاً');
});

test('repeated save clicks are idempotent (same id, no duplicates)', async () => {
  const { controller, db } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'source', 'One.', true);
  await controller.save({});
  await controller.save({});
  await controller.save({});
  assert.equal(db.records.size, 1);
});

test('stopping without save preserves a bounded unsaved draft; empty drafts are discarded', async () => {
  const { controller, storage } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  await controller.finish({});
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1);
  assert.equal(unsaved[0].saveRequested !== true, true);

  const { controller: emptyController, storage: emptyStorage } = makeController();
  await emptyController.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  const result = await emptyController.finish({});
  assert.equal(result, null);
  assert.equal(emptyStorage.store.has('plusUnsavedDrafts'), false);
});

test('autosave finalizes the session only while entitlement is valid', async () => {
  const { controller, db, setEntitlement } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  setEntitlement(LOCKED);
  await controller.finish({ autosave: true });
  assert.equal(db.records.size, 0, 'revoked entitlement blocks autosave');
});

test('autosave works while entitled', async () => {
  const { controller, db } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  await controller.finish({ autosave: true });
  assert.equal(db.records.size, 1);
});

test('drafts continue safely as free tier trial when locked', async () => {
  const { controller, storage, setEntitlement, advanceClock } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'قبل التغيير.', true);
  await controller.bookmark({ note: 'نقطة' });
  setEntitlement(LOCKED);
  advanceClock(6000);
  caption(controller, 'target', 'بعد التغيير.', true);
  await controller.finish({});
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1);
  assert.equal(unsaved[0].siteOrigin, 'youtube.com');
});

test('finish is idempotent — concurrent calls finalize exactly once', async () => {
  const { controller, storage } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  const first = controller.finish({});
  const second = controller.finish({});
  assert.equal(first, second, 'both calls share the same in-flight promise');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1, 'exactly one unsaved draft');
});

test('delayed persist followed by stop cannot resurrect the draft', async () => {
  const { controller, storage } = makeController({ storageOptions: { delayMs: 60 } });
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  const finishPromise = controller.finish({});
  await finishPromise;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(storage.store.has('plusActiveDraft'), false);
  assert.equal(storage.store.get('plusUnsavedDrafts').length, 1);
});

test('writes from an old session can never overwrite a newer session', async () => {
  const { controller, storage } = makeController({ storageOptions: { delayMs: 80 } });
  await controller.start({ startedAt: 0, siteOrigin: 'old.com' });
  caption(controller, 'target', 'قديم.', true);
  // Start a new session while the old session's writes are still in flight.
  await controller.start({ startedAt: 100_000, siteOrigin: 'new.com' });
  caption(controller, 'target', 'جديد.', true);
  await new Promise((r) => setTimeout(r, 200));
  const active = storage.store.get('plusActiveDraft');
  assert.equal(active.siteOrigin, 'new.com', 'new session owns the active draft');
});

test('bookmark persistence racing stop does not resurrect state', async () => {
  const { controller, storage } = makeController({ storageOptions: { delayMs: 40 } });
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  const bookmarkWrite = controller.bookmark({ note: 'أثناء الإيقاف' });
  const stop = controller.finish({});
  await Promise.all([bookmarkWrite.catch(() => undefined), stop]);
  await new Promise((r) => setTimeout(r, 100));
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1);
  assert.equal(unsaved[0].bookmarks.length, 1);
  assert.equal(storage.store.has('plusActiveDraft'), false);
});

test('failed permanent write retains the recovery copy with a storage warning', async () => {
  const { controller, db, storage } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  await controller.save({});
  assert.equal(db.records.size, 1);
  db.failures = 1; // the final update at stop fails
  const events = [];
  controller.subscribe((event) => events.push(event.type));
  const result = await controller.finish({});
  assert.equal(result, null, 'finalization must not pretend success');
  assert.equal(db.records.size, 1);
  // Durability contract: the plusActiveDraft recovery copy is RETAINED so a
  // retry (or a later restore) can complete the write; no unsaved duplicate.
  assert.equal(storage.store.has('plusActiveDraft'), true, 'recovery key retained');
  const recovery = storage.store.get('plusActiveDraft');
  assert.equal(recovery.targetSegments.length, 1);
  assert.equal(storage.store.has('plusUnsavedDrafts'), false);
  assert.ok(events.includes('PLUS_STORAGE_WARNING'));
  assert.ok(controller.status().storageWarning);

  // A later restore retries the same IndexedDB record successfully and only
  // then clears the recovery key.
  const { controller: retry, storage: retryStorage, db: retryDb } = makeController();
  retryStorage.store.set('plusActiveDraft', recovery);
  const restored = await retry.restore();
  assert.ok(restored, 'retry succeeds');
  assert.equal(retryDb.records.size, 1);
  assert.equal(retryStorage.store.has('plusActiveDraft'), false);
});

test('quota failure on session storage surfaces a warning without content', async () => {
  const { controller } = makeController({ storageOptions: { failWrites: true } });
  const events = [];
  controller.subscribe((event) => events.push(event));
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  caption(controller, 'target', 'نص.', true);
  await new Promise((r) => setTimeout(r, 30));
  const warning = controller.status().storageWarning;
  assert.ok(warning);
  assert.ok(!warning.includes('نص'), 'warning must not contain transcript content');
});

test('reload recovery finalizes a saved session into the SAME record', async () => {
  const first = makeController();
  await first.controller.start({ startedAt: 0, siteOrigin: 'youtube.com', title: 'عنوان', pageUrl: 'https://youtube.com/watch?v=1' });
  caption(first.controller, 'target', 'نص.', true);
  await first.controller.save({});
  // Simulate reload: persisted active draft still marks saveRequested.
  assert.equal(first.storage.store.get('plusActiveDraft').saveRequested, true);

  const second = makeController();
  // Carry the persisted storage over to the "restarted" controller.
  second.storage.store.set('plusActiveDraft', first.storage.store.get('plusActiveDraft'));
  await second.controller.restore();
  assert.equal(second.db.records.size, 1);
  assert.equal(second.storage.store.has('plusActiveDraft'), false);
  assert.equal(second.storage.store.has('plusUnsavedDrafts'), false);
});

test('reload recovery of an unsaved draft keeps it unsaved with metadata', async () => {
  const first = makeController();
  await first.controller.start({ startedAt: 0, siteOrigin: 'youtube.com', title: 'عنوان مؤقت', pageUrl: 'https://youtube.com/watch?v=2' });
  caption(first.controller, 'target', 'نص.', true);
  // Let the debounced persistence write the active draft.
  await new Promise((r) => setTimeout(r, 1700));

  const second = makeController();
  second.storage.store.set('plusActiveDraft', first.storage.store.get('plusActiveDraft'));
  await second.controller.restore();
  const unsaved = second.storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1);
  assert.equal(unsaved[0].title, 'عنوان مؤقت');
  assert.equal(unsaved[0].pageUrl, 'https://youtube.com/watch?v=2');
  assert.equal(second.db.records.size, 0);
});

test('reload recovery discards empty drafts', async () => {
  const { controller, storage } = makeController();
  storage.store.set('plusActiveDraft', {
    schemaVersion: 1,
    id: 'plussession_x1',
    createdAt: 5,
    sourceSegments: [],
    targetSegments: [],
    bookmarks: []
  });
  await controller.restore();
  assert.equal(storage.store.has('plusActiveDraft'), false);
  assert.equal(storage.store.has('plusUnsavedDrafts'), false);
});

test('reload recovery ignores tampered saveRequested values beyond a boolean', async () => {
  const { controller, storage } = makeController();
  storage.store.set('plusActiveDraft', {
    schemaVersion: 1,
    id: 'plussession_x2',
    createdAt: 5,
    title: 't',
    sourceSegments: [{ id: 's1', startMs: 0, endMs: 1, text: 'hi.' }],
    targetSegments: [],
    bookmarks: [],
    saveRequested: 'yes-please'
  });
  await controller.restore();
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved[0].saveRequested, false);
});

test('starting a new session preserves the previous unsaved draft', async () => {
  const { controller, storage } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'first.com' });
  caption(controller, 'target', 'أولى.', true);
  await controller.finish({});
  await controller.start({ startedAt: 100_000, siteOrigin: 'second.com' });
  const unsaved = storage.store.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1);
  assert.equal(unsaved[0].siteOrigin, 'first.com');
});

test('byte budget truncates old segments and flags the draft', async () => {
  const { controller } = makeController();
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  // Segments are capped at 2000 chars each; ~300 distinct ones (~1.2 MB
  // Arabic UTF-8) exceed the 1 MB active-draft byte budget. Unique prefixes
  // keep every segment distinct so the merge logic cannot collapse them.
  const bigArabic = (index) => `${index} ` + 'ش'.repeat(1990) + '.';
  for (let index = 0; index < 340; index += 1) {
    caption(controller, 'target', bigArabic(index), true);
  }
  // Force a persistence pass so the byte budget applies to the live draft.
  await controller.bookmark({ note: 'بعد الاقتطاع' });
  const status = controller.status();
  assert.equal(status.active.truncated, true);
  assert.ok(status.active.lineCount < 300);
});
