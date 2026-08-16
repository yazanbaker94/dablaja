import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlusDraftController } from '../src/shared/plus-draft-controller.js';
import { createBackup, parseBackup } from '../src/shared/plus-backup.js';
import { planBatchInsert } from '../src/shared/plus-db.js';
import {
  PLUS_LIMITS,
  createDraft,
  appendCaption,
  finalizeDraft
} from '../src/shared/plus-session.js';

const ENTITLED = { plusEnabled: true, state: 'development_preview' };

function storageWith({ failKeys = new Set(), delayMs = 0 } = {}) {
  const map = new Map();
  return {
    map,
    failKeys,
    async get(k) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return map.has(k) ? { [k]: structuredClone(map.get(k)) } : {};
    },
    async set(items) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      for (const [k, v] of Object.entries(items)) {
        if (failKeys.has(k)) throw new Error('quota exceeded');
        map.set(k, structuredClone(v));
      }
    },
    async remove(k) {
      if (failKeys.has(k)) throw new Error('remove failed');
      map.delete(k);
    }
  };
}

function dbWith({ failures = 0 } = {}) {
  const records = new Map();
  return {
    records,
    failures,
    putCalls: 0,
    async putSession(record) {
      this.putCalls += 1;
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

function makeController({ storageOptions = {}, dbOptions = {} } = {}) {
  const storage = storageWith(storageOptions);
  const db = dbWith(dbOptions);
  const controller = createPlusDraftController({
    storage,
    db,
    getEntitlement: async () => ENTITLED,
    now: () => 10_000
  });
  return { controller, storage, db };
}

const seed = async (c) => {
  await c.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  c.caption({ channel: 'target', text: 'نص.', final: true });
  // Force a persistence pass so the transcript exists beyond memory.
  await c.bookmark({ note: 'نقطة' });
};

// ---- 1. Draft durability during finish and recovery ------------------------

test('unsaved-list write failure during stop retains the recovery key and warns', async () => {
  const { controller, storage } = makeController({
    storageOptions: { failKeys: new Set(['plusUnsavedDrafts']) }
  });
  await seed(controller);
  const events = [];
  controller.subscribe((e) => events.push(e.type));
  const result = await controller.finish({});
  assert.equal(result, null, 'must not pretend finalization succeeded');
  assert.ok(storage.map.has('plusActiveDraft'), 'recovery copy retained');
  assert.ok(events.includes('PLUS_STORAGE_WARNING'));
  assert.ok(controller.status().storageWarning);
});

test('IndexedDB failure followed by unsaved-list failure keeps the recovery key', async () => {
  const first = makeController();
  await seed(first.controller);
  await first.controller.save({});
  const recovery = first.storage.map.get('plusActiveDraft');
  assert.ok(recovery);

  const second = makeController({
    dbOptions: { failures: 1 },
    storageOptions: { failKeys: new Set(['plusUnsavedDrafts']) }
  });
  second.storage.map.set('plusActiveDraft', recovery);
  const result = await second.controller.restore();
  assert.equal(result, null);
  assert.ok(second.storage.map.has('plusActiveDraft'), 'recovery entry retained after double failure');
});

test('IndexedDB failure during restore retains the recovery entry', async () => {
  const first = makeController();
  await seed(first.controller);
  await first.controller.save({});
  const second = makeController({ dbOptions: { failures: 1 } });
  second.storage.map.set('plusActiveDraft', first.storage.map.get('plusActiveDraft'));
  const result = await second.controller.restore();
  assert.equal(result, null);
  assert.ok(second.storage.map.has('plusActiveDraft'));
  const third = makeController();
  third.storage.map.set('plusActiveDraft', second.storage.map.get('plusActiveDraft'));
  const retried = await third.controller.restore();
  assert.ok(retried);
  assert.equal(third.storage.map.has('plusActiveDraft'), false);
  assert.equal(third.db.records.size, 1);
});

test('unsaved-list failure during restore retains the recovery entry', async () => {
  const first = makeController();
  await seed(first.controller);
  const second = makeController({
    storageOptions: { failKeys: new Set(['plusUnsavedDrafts']) }
  });
  second.storage.map.set('plusActiveDraft', first.storage.map.get('plusActiveDraft'));
  const result = await second.controller.restore();
  assert.equal(result, null);
  assert.ok(second.storage.map.has('plusActiveDraft'));
});

test('successful finish clears the recovery key only after the destination write', async () => {
  const { controller, storage, db } = makeController();
  await seed(controller);
  await controller.finish({});
  assert.equal(storage.map.has('plusActiveDraft'), false);
  assert.equal(storage.map.get('plusUnsavedDrafts').length, 1);
  assert.equal(db.putCalls, 0);
});

// ---- 2. Atomic 500-limit ---------------------------------------------------

test('concurrent new saves at 499 admit exactly one via the serialized transaction model', async () => {
  // Deterministic model of IndexedDB readwrite-transaction serialization:
  // a FIFO chain where each task runs EXACTLY ONCE, performing its
  // existence/count decision and write as one atomic unit.
  const limit = 500;
  const store = new Map();
  for (let i = 0; i < 499; i += 1) store.set(`plussession_s${i}`, { id: `plussession_s${i}` });
  let taskRuns = 0;
  let chain = Promise.resolve();
  const serialized = (task) => {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  };
  const fakePut = (id) => serialized(async () => {
    taskRuns += 1;
    const exists = store.has(id);
    const decision = planBatchInsert([{ id }], exists ? [id] : [], store.size, limit);
    if (decision.rejected.length) throw new Error('limit');
    store.set(id, { id });
    return true;
  });
  const results = await Promise.allSettled([fakePut('plussession_n1'), fakePut('plussession_n2')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one success');
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'exactly one limit rejection');
  assert.equal(store.size, 500, 'final count is exactly at the cap');
  assert.equal(taskRuns, 2, 'each task executed exactly once');
});

test('putSavedSession performs existence+count+put inside one transaction', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync('src/shared/plus-db.js', 'utf8')
  );
  const start = source.indexOf('export async function putSavedSession');
  const end = source.indexOf('export async function getSavedSession');
  const putBody = source.slice(start, end);
  assert.match(putBody, /transaction\(STORE, 'readwrite'\)/);
  assert.doesNotMatch(putBody, /withStore\('readonly'/, 'no separate readonly pre-read');
});

// ---- 3. Backup truthfulness ------------------------------------------------

function session(id, updatedAt = 1000) {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  draft.id = id;
  draft.updatedAt = updatedAt;
  appendCaption(draft, { channel: 'target', text: 'نص.', atMs: 1, final: true });
  return finalizeDraft(draft, { endedAt: 100 });
}

test('parseBackup keeps every valid record — no silent 500 slicing', () => {
  const many = Array.from({ length: 520 }, (_, i) => session(`plussession_b${i}`));
  const parsed = parseBackup(createBackup(many));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessions.length, 520);
  assert.equal(parsed.rejected, 0);
});

test('importing 10 new records into a 495-library admits 5 and reports 5 rejected', () => {
  const existing = Array.from({ length: 495 }, (_, i) => session(`plussession_e${i}`));
  const imported = Array.from({ length: 10 }, (_, i) => session(`plussession_n${i}`));
  const existingKeys = existing.map((s) => s.id);
  const plan = planBatchInsert(imported, existingKeys, 495, PLUS_LIMITS.MAX_SAVED_SESSIONS);
  assert.equal(plan.admittedNew.length, 5);
  assert.equal(plan.rejected.length, 5);
});

test('importing new records into a full library rejects all of them; updates still pass', () => {
  const existing = Array.from({ length: 500 }, (_, i) => session(`plussession_f${i}`));
  const fullKeys = existing.map((s) => s.id);
  const fresh = planBatchInsert([session('plussession_newX')], fullKeys, 500, PLUS_LIMITS.MAX_SAVED_SESSIONS);
  assert.equal(fresh.admittedNew.length, 0);
  assert.equal(fresh.rejected.length, 1);
  const update = planBatchInsert(
    [{ ...session('plussession_f0'), notes: 'محدثة' }],
    fullKeys,
    500,
    PLUS_LIMITS.MAX_SAVED_SESSIONS
  );
  assert.equal(update.admittedUpdates.length, 1);
  assert.equal(update.rejected.length, 0);
});

test('multibyte Arabic backup exceeding the UTF-8 byte limit is rejected by bytes, not chars', () => {
  const bigText = 'ش'.repeat(9 * 1024 * 1024); // ~18 MB UTF-8, ~9M characters
  const oversized = JSON.stringify({
    app: 'dablaja',
    kind: 'dablaja-plus-backup',
    schemaVersion: 1,
    sessions: [session('plussession_big1')]
  }).slice(0, 100) + bigText;
  const result = parseBackup(oversized, { maxBytes: 1024 * 1024 });
  assert.equal(result.ok, false);
  assert.match(result.error, /حجم/);
});

// ---- 6. Honest truncation/drop warnings ------------------------------------

test('three-draft limit drop produces a content-free warning', async () => {
  const { controller, storage } = makeController();
  const warnings = [];
  controller.subscribe((e) => {
    if (e.type === 'PLUS_STORAGE_WARNING') warnings.push(e.message);
  });
  for (let i = 0; i < 4; i += 1) {
    await controller.start({ startedAt: i * 1000, siteOrigin: `site${i}.com` });
    controller.caption({ channel: 'target', text: `نص ${i}.`, final: true });
    await controller.finish({});
  }
  const unsaved = storage.map.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 3, 'bounded at three');
  assert.ok(warnings.some((w) => w.includes('ثلاث مسودات')), 'drop warning surfaced');
  for (const warning of warnings) {
    assert.ok(!warning.includes('نص '), 'warnings never contain transcript content');
  }
});

test('byte-budget drop of an old unsaved draft produces a warning', async () => {
  const warnings = [];
  const pre = makeController();
  for (let i = 0; i < 3; i += 1) {
    await pre.controller.start({ startedAt: i, siteOrigin: `big${i}.com` });
    for (let j = 0; j < 4; j += 1) {
      pre.controller.caption({ channel: 'target', text: `${i}${j} ` + 'ش'.repeat(1990) + '.', final: true });
    }
    await pre.controller.finish({});
  }
  const fourth = makeController();
  fourth.controller.subscribe((e) => {
    if (e.type === 'PLUS_STORAGE_WARNING') warnings.push(e.message);
  });
  fourth.storage.map.set('plusUnsavedDrafts', pre.storage.map.get('plusUnsavedDrafts'));
  await fourth.controller.start({ startedAt: 9000, siteOrigin: 'small.com' });
  fourth.controller.caption({ channel: 'target', text: 'صغير.', final: true });
  await fourth.controller.finish({});
  const list = fourth.storage.map.get('plusUnsavedDrafts');
  assert.ok(list.length <= 3);
  assert.ok(
    warnings.some((w) => w.includes('حد التخزين') || w.includes('ثلاث مسودات')),
    'a drop warning was surfaced'
  );
});

test('queued active-draft writes are rejected for a stale session id', async () => {
  const { controller, storage } = makeController({ storageOptions: { delayMs: 50 } });
  await controller.start({ startedAt: 0, siteOrigin: 'first.com' });
  controller.caption({ channel: 'target', text: 'قديم.', final: true });
  await controller.start({ startedAt: 1000, siteOrigin: 'second.com' });
  await new Promise((r) => setTimeout(r, 150));
  const active = storage.map.get('plusActiveDraft');
  assert.equal(active.siteOrigin, 'second.com', 'stale write never overwrote the new session');
});

// ---- 7. Real idempotency test ----------------------------------------------

test('double finish coalesces: one in-flight promise, one destination write, no duplicates', async () => {
  const { controller, storage } = makeController({ storageOptions: { delayMs: 30 } });
  await seed(controller);
  const first = controller.finish({});
  const second = controller.finish({});
  assert.equal(first, second, 'both calls share the same in-flight promise');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  const unsaved = storage.map.get('plusUnsavedDrafts');
  assert.equal(unsaved.length, 1, 'exactly one unsaved draft');
  assert.ok(storage.map.has('plusActiveDraft') === false);
});

// ---- 3b. Recovery dedupe by session id --------------------------------------

test('failed active-key removal then restore yields exactly one unsaved draft', async () => {
  // 1) Successful unsaved destination write; 2) active-key removal fails;
  // 3) later restore appends the same session again — dedupe must keep one.
  const first = makeController();
  await seed(first.controller);
  first.storage.failKeys.add('plusActiveDraft');
  await first.controller.finish({});
  assert.ok(first.storage.map.has('plusActiveDraft'), 'stale recovery key retained after failed removal');
  assert.equal(first.storage.map.get('plusUnsavedDrafts').length, 1);

  const second = makeController();
  second.storage.map.set('plusActiveDraft', first.storage.map.get('plusActiveDraft'));
  second.storage.map.set('plusUnsavedDrafts', first.storage.map.get('plusUnsavedDrafts'));
  await second.controller.restore();
  const unsaved = second.storage.map.get('plusUnsavedDrafts');
  const ids = unsaved.map((draft) => draft.id);
  assert.equal(unsaved.length, 1, 'no duplicate unsaved card');
  assert.equal(new Set(ids).size, 1);
});
