// Plus message boundary — one central, adapter-injected handler the service
// worker delegates to. Every PAID mutation passes through requirePlusEntitlement();
// read/export/delete of already-owned data stays available while locked so user
// data is never held hostage. UI disabled states are never trusted.
//
// Every response uses one consistent shape:
//   { ok, plus: { entitlement, autosave, rememberVolumes, siteProfiles },
//     draft: <active draft summary or null>, storageWarning }

import { mergeSessions, parseBackup } from './plus-backup.js';
import { removeBookmark, setNotes } from './plus-session.js';

const LOCKED_ERROR = 'Plus غير مفعّل لهذا الجهاز.';
const MAX_ID_LENGTH = 80;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;

function requireId(value, label = 'المعرّف') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_ID_LENGTH || !/^[\w-]+$/.test(text)) {
    throw new Error(`${label} غير صالح.`);
  }
  return text;
}

function boundText(value, maxLength, label = 'النص') {
  const text = typeof value === 'string' ? value : '';
  if (text.length > maxLength * 3) {
    throw new Error(`${label} أطول من المسموح.`);
  }
  return text.slice(0, maxLength);
}

export function createPlusMessageHandler({
  controller,        // plus-draft-controller instance
  library,           // { get(id), list(), put(record), delete(id), clear(), putBatch(records) }
  settings,          // { get(), setAutosave(v), setRemember(v), deleteProfile(origin) }
  entitlement        // async () => { entitlement: { plusEnabled, ... }, ... } (full settings)
} = {}) {
  if (!controller || !library || !settings || typeof entitlement !== 'function') {
    throw new Error('Plus message handler requires controller, library, settings and entitlement.');
  }

  // Central enforcement: default to locked when entitlement data is missing
  // or malformed — never trust an undefined shape.
  async function requirePlusEntitlement() {
    let resolved = null;
    try {
      resolved = await entitlement();
    } catch {
      resolved = null;
    }
    const entitlementState = resolved?.entitlement;
    if (!entitlementState || typeof entitlementState !== 'object' || entitlementState.plusEnabled !== true) {
      throw new Error(LOCKED_ERROR);
    }
    return entitlementState;
  }

  async function fullStatus() {
    const [plus, draftStatus] = await Promise.all([
      entitlement().catch(() => null),
      Promise.resolve().then(() => controller.status())
    ]);
    return {
      plus: plus || { entitlement: { plusEnabled: false, state: 'locked', label: '' }, autosave: false, rememberVolumes: false, siteProfiles: [] },
      draft: draftStatus.active || null,
      storageWarning: draftStatus.storageWarning || null
    };
  }

  async function withStatus(payload = {}) {
    const status = await fullStatus();
    // Payload wins so mutations that return fresh settings override the
    // status snapshot; everything else carries the consistent shape.
    return { ...status, ok: true, ...payload };
  }

  return async function handlePlusMessage(message) {
    switch (message.type) {
      case 'PLUS_GET_STATUS':
        return withStatus();

      // ---- Paid mutations (entitlement-gated) ----
      case 'PLUS_SAVE_ACTIVE':
        await requirePlusEntitlement();
        return withStatus({ saved: await controller.save({ title: boundText(message.title || '', MAX_TITLE_LENGTH) }) });
      case 'PLUS_SAVE_UNSAVED':
        await requirePlusEntitlement();
        return withStatus({
          saved: await controller.saveUnsaved(requireId(message.draftId, 'معرّف الجلسة'), {
            title: boundText(message.title || '', MAX_TITLE_LENGTH)
          })
        });
      case 'PLUS_ADD_BOOKMARK':
        await requirePlusEntitlement();
        await controller.bookmark({ note: boundText(message.note || '', 500) });
        return withStatus();
      case 'PLUS_SET_AUTOSAVE':
        await requirePlusEntitlement();
        return withStatus({ plus: await settings.setAutosave(message.value === true) });
      case 'PLUS_SET_REMEMBER_VOLUMES':
        await requirePlusEntitlement();
        return withStatus({ plus: await settings.setRemember(message.value === true) });
      case 'PLUS_DELETE_SITE_PROFILE':
        await requirePlusEntitlement();
        return withStatus({ plus: await settings.deleteProfile(boundText(message.origin || '', 300)) });
      case 'PLUS_UPDATE_NOTES': {
        await requirePlusEntitlement();
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        setNotes(record, boundText(message.notes ?? '', MAX_NOTE_LENGTH, 'الملاحظات'));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'PLUS_DELETE_BOOKMARK': {
        await requirePlusEntitlement();
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        removeBookmark(record, requireId(message.bookmarkId, 'معرّف العلامة'));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'PLUS_UPDATE_BOOKMARK': {
        await requirePlusEntitlement();
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        const bookmarkId = requireId(message.bookmarkId, 'معرّف العلامة');
        const bookmark = record.bookmarks.find((item) => item.id === bookmarkId);
        if (!bookmark) throw new Error('لم يتم العثور على العلامة.');
        bookmark.note = boundText(message.note ?? '', 500);
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'PLUS_IMPORT_BACKUP': {
        await requirePlusEntitlement();
        // Trust boundary: the raw backup TEXT is parsed here in the worker.
        // parseBackup enforces the UTF-8 byte limit itself — no pre-truncation
        // here that could turn a size error into a misleading JSON error.
        if (typeof message.rawBackup !== 'string') {
          throw new Error('محتوى النسخة الاحتياطية غير صالح.');
        }
        const parsed = parseBackup(message.rawBackup);
        if (!parsed.ok) throw new Error(parsed.error);
        const existing = await library.list();
        // Only the records that actually need writing (new + genuinely newer
        // updates) go to the atomic batch; unchanged existing records are
        // never rewritten. Counts come from the database outcome, so
        // `added`/`updated`/`rejected` reflect real writes.
        const merged = mergeSessions(existing, parsed.sessions);
        const result = await library.putBatch([...merged.updatedRecords, ...merged.newRecords]);
        return withStatus({
          added: result.writtenNew ?? 0,
          updated: result.writtenUpdates ?? 0,
          invalidRecords: parsed.rejected || 0,
          superseded: merged.superseded || 0,
          rejected: result.rejected ?? 0
        });
      }

      // ---- Allowed while locked: discard owned unsaved drafts ----
      case 'PLUS_DISCARD_DRAFT':
        await controller.discardUnsaved(requireId(message.draftId, 'معرّف الجلسة'));
        return withStatus();
      default:
        return { ok: false, error: 'طلب Plus غير معروف.' };
    }
  };
}
