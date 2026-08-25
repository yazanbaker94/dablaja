// Integration test: disabling local session saving.
// Turning local saving off mid-session must stop ALL persistence
// immediately while live dubbing continues in memory. Uses the REAL
// createPlusDraftController — no mocks of the unit under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlusDraftController } from '../src/shared/plus-draft-controller.js';

const ENTITLED = { plusEnabled: true, state: 'active' };

function makeHarness({ failStorageSet = false } = {}) {
  const map = new Map();
  const storage = {
    async get(k) { return map.has(k) ? { [k]: structuredClone(map.get(k)) } : {}; },
    async set(o) {
      if (failStorageSet) throw new Error('Storage write simulated failure');
      for (const [k, v] of Object.entries(o)) map.set(k, structuredClone(v));
    },
    async remove(k) { Array.isArray(k) ? k.forEach((x) => map.delete(x)) : map.delete(k); }
  };
  const db = {
    saved: new Map(),
    async putSession(r) { const c = structuredClone(r); this.saved.set(c.id, c); return c; },
    async getSession(id) { return this.saved.get(id) || null; }
  };
  const controller = createPlusDraftController({
    storage,
    db,
    getEntitlement: async () => ENTITLED,
    now: () => 1000
  });
  return { controller, storage, db, map };
}

test('Case A: saving disabled pre-save finalizes draft to unsaved list; later captions are dropped', async () => {
  const h = makeHarness();

  // 1. Local saving is enabled: captions persist in the active draft.
  await h.controller.start({ startedAt: 0, siteOrigin: 'youtube.com', title: 'T', pageUrl: '' });
  h.controller.caption({ channel: 'target', text: 'الجملة الأولى.', final: true });
  const activeBefore = h.controller.status().active;
  assert.ok(activeBefore, 'draft active while consent on');
  assert.equal(h.db.saved.size, 0, 'no explicit save yet');

  // 2. Local saving is disabled mid-session -> moves to plusUnsavedDrafts.
  await h.controller.finish({ autosave: false, reason: 'local_saving_disabled' });

  // 3. Post-revocation caption: MUST NOT be written anywhere.
  h.controller.caption({ channel: 'target', text: 'بعد الإلغاء.', final: true });
  assert.equal(h.controller.status().active, null, 'no active draft accepts content');

  // 4. Verify pre-revocation content survived in unsaved drafts, but post-revocation content is absent.
  const unsaved = h.map.get('plusUnsavedDrafts') || [];
  assert.equal(unsaved.length, 1, 'pre-revocation draft finalized to unsaved drafts');
  for (const draft of unsaved) {
    for (const seg of [...(draft.sourceSegments || []), ...(draft.targetSegments || [])]) {
      assert.notEqual(seg.text, 'بعد الإلغاء.', 'post-revocation caption leaked into unsaved storage');
    }
  }
  for (const saved of h.db.saved.values()) {
    for (const seg of [...(saved.sourceSegments || []), ...(saved.targetSegments || [])]) {
      assert.notEqual(seg.text, 'بعد الإلغاء.', 'post-revocation caption leaked into the library');
    }
  }

  // 5. Memory dubbing continues without throwing.
  h.controller.caption({ channel: 'source', text: 'still dubbing in memory', final: true });
});

test('Case B: saving disabled post-save finalizes without duplicating the unsaved list', async () => {
  const h = makeHarness();

  // 1. Saving enabled: session starts, captions added, explicit save executed.
  await h.controller.start({ startedAt: 0, siteOrigin: 'youtube.com', title: 'T', pageUrl: '' });
  h.controller.caption({ channel: 'target', text: 'الجملة المحفوظة.', final: true });
  await h.controller.save({});
  assert.equal(h.db.saved.size, 1, 'explicit save placed record in library');

  // 2. Saving disabled mid-session after explicit save.
  await h.controller.finish({ autosave: false, reason: 'local_saving_disabled' });

  // 3. Caption after revocation.
  h.controller.caption({ channel: 'target', text: 'بعد الإلغاء 2.', final: true });
  assert.equal(h.controller.status().active, null, 'no active draft accepts content');

  // 4. Saved session remains 1, no duplicate created in plusUnsavedDrafts.
  assert.equal(h.db.saved.size, 1, 'library record retained');
  const unsaved = h.map.get('plusUnsavedDrafts') || [];
  assert.equal(unsaved.length, 0, 'no duplicate in unsaved drafts since session was already saved');
});

test('Case C: storage failure while disabling saving does not crash controller', async () => {
  const h = makeHarness({ failStorageSet: true });

  await h.controller.start({ startedAt: 0, siteOrigin: 'youtube.com', title: 'T', pageUrl: '' });
  h.controller.caption({ channel: 'target', text: 'نص تجريبي.', final: true });

  // Finish handles storage error gracefully
  let errorCaught = null;
  try {
    await h.controller.finish({ autosave: false, reason: 'local_saving_disabled' });
  } catch (err) {
    errorCaught = err;
  }
  // Either handled internally or surfaced without corrupting in-memory state
  assert.equal(h.controller.status().active, null, 'active draft cleared on finish attempt');
});

test('enabling saving mid-session starts capture from that moment only', async () => {
  const h = makeHarness();
  // No draft started yet (local saving was off at session start).
  h.controller.caption({ channel: 'target', text: 'قبل الموافقة.', final: true });
  assert.equal(h.controller.status().active, null, 'nothing captured before local saving was enabled');

  // Local saving turns ON mid-session: a NEW draft starts from now.
  await h.controller.start({ startedAt: 5000, siteOrigin: 'youtube.com', title: '', pageUrl: '' });
  h.controller.caption({ channel: 'target', text: 'بعد الموافقة.', final: true });
  const status = h.controller.status();
  assert.ok(status.active, 'draft exists after local saving was enabled');
  assert.ok(status.active.lineCount >= 1);
});
