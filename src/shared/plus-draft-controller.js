// Plus draft controller — owns the live draft lifecycle with serialized,
// generation-checked persistence. Adapter-injected (no chrome.* here) so the
// race/budget/finalization semantics are unit-testable with fakes.
//
// Guarantees:
//  • Every queued storage write carries the session generation; writes from a
//    finished/replaced session can never commit.
//  • finish() is idempotent per session: drains the queue, cancels timers,
//    and updates an explicitly-saved/autosaved IndexedDB record instead of
//    creating a duplicate unsaved draft.
//  • Draft capture obeys the local-saving setting (chrome.storage.local);
//    entitlement only enforces tier limits (free: 1 session/1 bookmark/1
//    profile, Plus: 500/100/50). Revocation mid-session stops persistence
//    without touching live dubbing.
//  • Autosave respects that setting and the tier; if the free cap is reached,
//    it retains a visible unsaved draft.
//  • Byte budgets (UTF-8) cap the active draft and the unsaved-draft list;
//    truncation is surfaced, never silent.

import {
  addBookmark,
  appendCaption,
  compactTombstones,
  createDraft,
  finalizeDraft,
  mergeDraftWithSaved,
  sessionTitleOrDefault,
  snapshotDraft,
  transcriptLineCount,
  truncateDraftToByteBudget,
  trimDrafts,
  trimUnsavedDraftsToByteBudget,
  validateSessionRecord
} from './plus-session.js';

const ACTIVE_KEY = 'plusActiveDraft';
const UNSAVED_KEY = 'plusUnsavedDrafts';

export function createPlusDraftController({
  storage,                                  // { get(key), set(obj), remove(keyOrArray) } — async
  db,                                       // { putSession(record), getSession(id) } — async, throws on failure
  getEntitlement,                           // async () => { plusEnabled: boolean }
  now = Date.now
} = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new Error('Plus draft controller requires a storage adapter.');
  }
  if (!db || typeof db.putSession !== 'function') {
    throw new Error('Plus draft controller requires a database adapter.');
  }
  if (typeof getEntitlement !== 'function') {
    throw new Error('Plus draft controller requires an entitlement provider.');
  }

  let active = null;            // live draft (mutable) — null when not capturing
  let activeSessionId = null;   // session id owning queued active-draft writes
  let generation = 0;           // monotonic session generation
  let persistTimer = null;
  let chain = Promise.resolve(); // serialized persistence queue
  let finished = true;          // whether the current active draft already finalized
  let lastStorageWarning = null;
  const listeners = new Set();

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  function statusPayload() {
    return {
      active: active
        ? {
            id: active.id,
            startedAt: active.startedAt,
            siteOrigin: active.siteOrigin,
            lineCount: transcriptLineCount(active),
            bookmarkCount: active.bookmarks.length,
            truncated: active.truncated === true,
            saved: active.saveRequested === true
          }
        : null,
      storageWarning: lastStorageWarning
    };
  }

  function broadcast() {
    emit({ type: 'PLUS_DRAFT_CHANGED', ...statusPayload() });
  }

  // Serialized queue: every write is an immutable snapshot stamped with the
  // generation AND session id; it is skipped if either no longer matches.
  function enqueueWrite(sessionId, snapshot) {
    const writeGeneration = generation;
    const record = structuredClone(snapshot);
    chain = chain.then(async () => {
      if (writeGeneration !== generation || !record) return;
      if (activeSessionId !== sessionId) return;
      try {
        await storage.set({ [ACTIVE_KEY]: record });
        lastStorageWarning = null;
      } catch {
        // Storage failures are surfaced without any transcript content.
        warn('تعذر حفظ مسودة الجلسة مؤقتاً على الجهاز.');
      }
    });
    return chain;
  }

  function warn(message) {
    lastStorageWarning = message;
    emit({ type: 'PLUS_STORAGE_WARNING', message });
  }

  async function readUnsaved() {
    try {
      const stored = await storage.get(UNSAVED_KEY);
      const list = stored[UNSAVED_KEY];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async function writeUnsaved(drafts) {
    await storage.set({ [UNSAVED_KEY]: drafts });
  }

  function schedulePersist() {
    if (persistTimer || !active || finished) return;
    // The timer is stamped with both the generation and session id so a
    // late callback from a replaced session can never persist stale state.
    const timerGeneration = generation;
    const timerSessionId = active.id;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (timerGeneration !== generation || !active || active.id !== timerSessionId || finished) return;
      persistSnapshot();
    }, 1500);
  }

  function persistSnapshot() {
    if (!active || finished) return;
    const wasTruncated = active.truncated === true;
    const { draft } = truncateDraftToByteBudget(active);
    if (!wasTruncated && draft.truncated === true) {
      warn('اقتُطع أقدم جزء من نص المسودة بسبب حدود التخزين المحلي.');
    }
    // snapshotDraft finalizes a CLONE, so live-only state on `active`
    // (pending interim text is flushed into the snapshot; saveRequested
    // travels inside the record and survives validated restore).
    enqueueWrite(active.id, snapshotDraft(draft, { endedAt: now() }));
  }

  async function start({ startedAt, siteOrigin = '', title = '', pageUrl = '' } = {}) {
    // Preserve any in-memory unfinished draft, then flush any persisted draft
    // left by a previous/revoked session — the new session must never
    // silently overwrite either.
    await finish({ reason: 'restart' });
    await restore().catch(() => undefined);
    generation += 1;
    finished = false;
    active = createDraft({ startedAt, siteOrigin, title, pageUrl });
    activeSessionId = active.id;
    await enqueueWrite(active.id, active);
    broadcast();
    return active;
  }

  function caption({ channel, text, final = false, speaker = '', turnId = null }) {
    if (!active || finished) return;
    const atMs = Math.max(0, now() - active.startedAt);
    appendCaption(active, { channel, text, final, atMs, speaker, turnId });
    schedulePersist();
  }

  function bookmark({ note = '' } = {}) {
    if (!active || finished) {
      return Promise.reject(new Error('لا توجد جلسة نشطة لإضافة علامة.'));
    }
    addBookmark(active, { atMs: now() - active.startedAt, note });
    const write = persistSnapshotNow();
    broadcast();
    return write;
  }

  async function persistSnapshotNow() {
    if (!active || finished) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    persistSnapshot();
    await chain;
  }

  // Explicit «احفظ الجلسة». Idempotent: repeat clicks re-save the same record.
  async function save({ title = '' } = {}) {
    if (!active || finished) throw new Error('لا توجد جلسة نشطة للحفظ.');
    const cleanTitle = title ? sessionTitleOrDefault(title, active.siteOrigin) : '';
    if (cleanTitle) active.title = cleanTitle;
    active.saveRequested = true;
    await persistSnapshotNow();
    const snapshot = snapshotDraft(active, { endedAt: now() });
    try {
      const saved = await db.putSession(snapshot);
      lastStorageWarning = null;
      broadcast();
      return saved;
    } catch (error) {
      // Permanent write failed: surface a real actionable error.
      throw new Error(error?.message || 'تعذر حفظ الجلسة في المكتبة.');
    }
  }

  // Idempotent terminal path for Stop, fatal, start failure, reload recovery…
  // Concurrent calls coalesce onto the same in-flight completion.
  let finishInFlight = null;

  function finish(options = {}) {
    if (finishInFlight) return finishInFlight;
    finishInFlight = performFinish(options)
      .catch(() => {
        // Never leave terminal state stuck, but never drop the recovery key
        // either — the persisted plusActiveDraft copy retains the transcript
        // for a later retry.
        finished = true;
        active = null;
        activeSessionId = null;
        warn('تعذر إنهاء حفظ الجلسة؛ أُبقيت نسخة استرجاع محلية للمحاولة لاحقاً.');
        broadcast();
        return null;
      })
      .finally(() => {
        finishInFlight = null;
      });
    return finishInFlight;
  }

  async function clearActiveKey() {
    await storage.remove(ACTIVE_KEY);
  }

  async function clearActiveKeyBestEffort() {
    try {
      await clearActiveKey();
    } catch {
      warn('تعذر حذف نسخة الاسترجاع المؤقتة؛ سيعاد توليدها لاحقاً.');
    }
  }

  async function performFinish({ autosave = false } = {}) {
    if (!active) {
      finished = true;
      return null;
    }
    const current = active;
    clearTimeout(persistTimer);
    persistTimer = null;
    generation += 1; // invalidate every queued live write for this session
    await chain;     // drain in-flight writes before touching destinations
    finished = true;
    active = null;
    activeSessionId = null;

    const final = finalizeDraft(current, { endedAt: now() });
    const hasContent = transcriptLineCount(final) > 0 || final.bookmarks.length > 0;
    if (!hasContent) {
      // Genuinely empty drafts carry nothing worth recovering.
      await clearActiveKeyBestEffort();
      broadcast();
      return null;
    }
    const { draft: bounded, truncated } = truncateDraftToByteBudget(final);
    if (truncated) {
      warn('اقتُطع أقدم جزء من نص الجلسة بسبب حدود التخزين المحلي.');
    }

    // DURABILITY: first persist the newest bounded finalized snapshot as the
    // recovery copy, so a later destination failure cannot lose the newest
    // transcript. plusActiveDraft is removed only after the destination write
    // succeeds.
    try {
      await storage.set({ [ACTIVE_KEY]: structuredClone(bounded) });
    } catch {
      warn('تعذر تحديث نسخة الاسترجاع المؤقتة قبل إنهاء الجلسة.');
    }

    // Autosave only while the entitlement is still valid; an explicitly
    // saved session always completes its user-initiated record.
    let autosaveAllowed = false;
    if (autosave === true) {
      const entitlement = await getEntitlement().catch(() => null);
      autosaveAllowed = entitlement?.plusEnabled === true;
    }

    if (current.saveRequested === true || autosaveAllowed) {
      try {
        // Deterministic merge: bookmarks need stable IDs + updatedAt,
        // deletions use tombstones, notes use updatedAt. Finishing must
        // merge without resurrecting deleted bookmarks or reverting newer notes.
        let finalRecord = bounded;
        if (typeof db.getSession === 'function') {
          const existing = await db.getSession(current.id).catch(() => null);
          if (existing) {
            finalRecord = mergeDraftWithSaved(bounded, existing);
          }
        }
        finalRecord = compactTombstones(finalRecord);
        const saved = await db.putSession(finalRecord);
        await clearActiveKeyBestEffort();
        broadcast();
        return saved;
      } catch (error) {
        // Storage failure (or the 500-record cap) must retain the unsaved
        // draft, never destroy the user's transcript.
        if (error?.code === 'saved_session_limit') {
          try {
            const drafts = await preserveUnsaved(bounded);
            await clearActiveKeyBestEffort();
            warn('وصلت إلى حد الجلسات المحفوظة (500) — بقيت الجلسة كمسودة. صدّر نسخة احتياطية أو احذف جلسات قديمة.');
            broadcast();
            return drafts;
          } catch {
            warn('تعذر حفظ المسودة غير المحفوظة؛ أُبقيت نسخة استرجاع محلية للمحاولة لاحقاً.');
            broadcast();
            return null;
          }
        }
        warn('تعذر تحديث الجلسة المحفوظة في المكتبة؛ أُبقيت نسخة استرجاع محلية.');
        broadcast();
        return null; // finalization did NOT durably complete — say so.
      }
    }

    try {
      const drafts = await preserveUnsaved(bounded);
      await clearActiveKeyBestEffort();
      broadcast();
      return drafts;
    } catch {
      warn('تعذر حفظ المسودة غير المحفوظة؛ أُبقيت نسخة استرجاع محلية للمحاولة لاحقاً.');
      broadcast();
      return null;
    }
  }

  // Appends the draft to the unsaved list (newest first, three-draft and
  // byte-budget caps), deduplicated by session id — if a previous finish
  // succeeded but the active-key removal failed, a later restore must not
  // create a second card for the same session. Duplicate resolution keeps
  // the newest/most complete record deterministically. Throws on storage
  // failure. Surfaces content-free warnings when older drafts are dropped;
  // user notes/bookmarks are never silently discarded.
  async function preserveUnsaved(draft) {
    const existing = await readUnsaved();
    const byId = new Map();
    for (const item of [...existing, draft]) {
      if (!item?.id) continue;
      const previous = byId.get(item.id);
      if (!previous) {
        byId.set(item.id, item);
        continue;
      }
      // Newest wins; ties break toward the more complete transcript, then
      // toward the later entry (the incoming draft).
      const previousScore = (previous.updatedAt || 0) * 1_000_000 + transcriptLineCount(previous);
      const itemScore = (item.updatedAt || 0) * 1_000_000 + transcriptLineCount(item);
      if (itemScore >= previousScore) byId.set(item.id, item);
    }
    const deduped = [...byId.values()];
    const trimmed = trimDrafts(deduped);
    if (trimmed.length < deduped.length) {
      warn('حُذفت مسودة غير محفوظة قديمة لتجاوز حد الثلاث مسودات.');
    }
    const budget = trimUnsavedDraftsToByteBudget(trimmed);
    if (budget.dropped > 0) {
      warn('حُذفت مسودة غير محفوظة قديمة لتجاوز حد التخزين المحلي.');
    }
    await writeUnsaved(budget.drafts);
    return budget.drafts;
  }

  async function saveUnsaved(draftId, { title = '' } = {}) {
    const drafts = await readUnsaved();
    const target = drafts.find((draft) => draft.id === draftId);
    if (!target) throw new Error('لم يتم العثور على الجلسة غير المحفوظة.');
    if (title) target.title = sessionTitleOrDefault(title, target.siteOrigin);
    const saved = await db.putSession(target);
    await writeUnsaved(drafts.filter((draft) => draft.id !== draftId));
    broadcast();
    return saved;
  }

  async function discardUnsaved(draftId) {
    const drafts = await readUnsaved();
    await writeUnsaved(drafts.filter((draft) => draft.id !== draftId));
    broadcast();
    return true;
  }

  // Startup recovery: a persisted active draft from a browser-session that
  // ended must be finalized immediately, never left accepting bookmarks.
  // Recovery preserves whether the user had already explicitly saved: saved
  // sessions finalize into the SAME IndexedDB record; unsaved ones become a
  // bounded unsaved draft with their temporary metadata retained. The
  // recovery entry is removed only AFTER the destination write succeeds.
  async function restore() {
    let stored = null;
    try {
      const result = await storage.get(ACTIVE_KEY);
      stored = result[ACTIVE_KEY];
    } catch {
      return null;
    }
    if (!stored) return null;
    const restored = validateSessionRecord(stored);
    if (!restored) {
      // Invalid entries may be removed immediately.
      await clearActiveKeyBestEffort();
      return null;
    }
    generation += 1;
    finished = true;
    active = null;
    activeSessionId = null;
    const hasContent = transcriptLineCount(restored) > 0 || restored.bookmarks.length > 0;
    if (!hasContent) {
      // Genuinely empty recovery entries may be removed immediately.
      await clearActiveKeyBestEffort();
      return null;
    }
    if (restored.saveRequested === true) {
      try {
        // Merge same as finish: respect updatedAt/tombstones
        let finalRecord = restored;
        if (typeof db.getSession === 'function') {
          const existing = await db.getSession(restored.id).catch(() => null);
          if (existing) finalRecord = mergeDraftWithSaved(restored, existing);
        }
        finalRecord = compactTombstones(finalRecord);
        const saved = await db.putSession(finalRecord);
        await clearActiveKey();
        broadcast();
        return saved;
      } catch {
        warn('تعذر تحديث الجلسة المحفوظة أثناء الاسترجاع؛ بقيت نسخة الاسترجاع للمحاولة لاحقاً.');
        broadcast();
        return null;
      }
    }
    try {
      const drafts = await preserveUnsaved(restored);
      await clearActiveKey();
      broadcast();
      return drafts;
    } catch {
      warn('تعذر حفظ الجلسة المسترجعة كمسودة؛ بقيت نسخة الاسترجاع للمحاولة لاحقاً.');
      broadcast();
      return null;
    }
  }

  return {
    start,
    caption,
    bookmark,
    save,
    saveActive: save,
    finish,
    saveUnsaved,
    discardUnsaved,
    restore,
    status: statusPayload,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
