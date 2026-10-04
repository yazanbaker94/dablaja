// Library draft controller — owns the live draft lifecycle with serialized,
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
//    disabling it mid-session stops persistence without touching live
//    dubbing.
//  • Autosave respects that setting; if the 500-session cap is reached, the
//    internal recovery snapshot is kept and a warning is surfaced.
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
  validateSessionRecord
} from './library-session.js';
import { SESSION_STORAGE_KEYS } from './constants.js';

const ACTIVE_KEY = SESSION_STORAGE_KEYS.LIBRARY_ACTIVE_DRAFT;

export function createLibraryDraftController({
  storage,                                  // { get(key), set(obj), remove(keyOrArray) } — async
  db,                                       // { putSession(record), getSession(id) } — async, throws on failure
  now = Date.now
} = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new Error('Library draft controller requires a storage adapter.');
  }
  if (!db || typeof db.putSession !== 'function') {
    throw new Error('Library draft controller requires a database adapter.');
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
    emit({ type: 'LIBRARY_DRAFT_CHANGED', ...statusPayload() });
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
        warn('تعذر حفظ نسخة الاسترجاع المؤقتة على الجهاز.');
      }
    });
    return chain;
  }

  function warn(message) {
    lastStorageWarning = message;
    emit({ type: 'LIBRARY_STORAGE_WARNING', message });
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
      warn('اقتُطع أقدم جزء من نص الجلسة بسبب حدود التخزين المحلي.');
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

    // Autosave is a local-storage choice controlled by the caller.
    const autosaveAllowed = autosave === true;

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
        // Storage failure (or the 500-record cap) keeps the internal recovery
        // snapshot. It must never create a user-facing draft card.
        if (error?.code === 'saved_session_limit') {
          warn('وصلت إلى حد الجلسات المحفوظة (500). صدّر نسخة احتياطية أو احذف جلسة قديمة، ثم أعد المحاولة.');
          broadcast();
          return null;
        }
        warn('تعذر تحديث الجلسة المحفوظة في المكتبة؛ أُبقيت نسخة استرجاع محلية.');
        broadcast();
        return null; // finalization did NOT durably complete — say so.
      }
    }

    warn('لم تُحفظ الجلسة؛ أُبقيت نسخة استرجاع محلية مؤقتة.');
    broadcast();
    return null;
  }

  // Startup recovery always produces the same real IndexedDB record. The
  // recovery entry is removed only after that destination write succeeds.
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
    try {
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
      warn('تعذر استرجاع الجلسة إلى المكتبة؛ بقيت نسخة الاسترجاع المحلية للمحاولة لاحقاً.');
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
    restore,
    status: statusPayload,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
