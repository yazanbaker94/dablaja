// Library message boundary — one central, adapter-injected handler the service
// worker delegates to for local session-library requests. Inputs from UI pages
// are validated and bounded here; UI disabled states are never trusted.
//
// Every response uses one consistent shape:
//   { ok, librarySettings: { rememberVolumes, localSavingEnabled, siteProfiles },
//     draft: <active draft summary or null>, storageWarning }

import { mergeSessions, parseBackup } from './library-backup.js';
import { removeBookmark, setNotes, updateBookmarkNote } from './library-session.js';

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

export function createLibraryMessageHandler({
  controller,        // library-draft-controller instance
  library,           // { get(id), list(), put(record), delete(id), clear(), putBatch(records) }
  settings           // { get(), setRemember(v), deleteProfile(origin), updateProfile(origin, volumes) }
} = {}) {
  if (!controller || !library || !settings || typeof settings.get !== 'function') {
    throw new Error('Library message handler requires controller, library and settings.');
  }

  async function fullStatus() {
    const savedCountRequest = typeof library.count === 'function'
      ? Promise.resolve().then(() => library.count())
      : Promise.resolve().then(() => library.list()).then((records) => Array.isArray(records) ? records.length : 0);
    const [librarySettings, draftStatus, savedSessionCount] = await Promise.all([
      Promise.resolve().then(() => settings.get()).catch(() => null),
      Promise.resolve().then(() => controller.status()),
      savedCountRequest.catch(() => 0)
    ]);
    return {
      librarySettings: librarySettings || { rememberVolumes: false, localSavingEnabled: true, siteProfiles: [] },
      draft: draftStatus.active || null,
      storageWarning: draftStatus.storageWarning || null,
      savedSessionCount: Number.isFinite(Number(savedSessionCount)) ? Math.max(0, Number(savedSessionCount)) : 0
    };
  }

  async function withStatus(payload = {}) {
    const status = await fullStatus();
    // Payload wins so mutations that return fresh settings override the
    // status snapshot; everything else carries the consistent shape.
    return { ...status, ok: true, ...payload };
  }

  return async function handleLibraryMessage(message) {
    switch (message.type) {
      case 'LIBRARY_GET_STATUS':
        return withStatus();

      // ---- Session & profile mutations ----
      case 'LIBRARY_SAVE_ACTIVE': {
        const active = controller.status()?.active;
        if (!active?.id) throw new Error('لا توجد جلسة نشطة للحفظ.');
        return withStatus({ saved: await controller.save({ title: boundText(message.title || '', MAX_TITLE_LENGTH) }) });
      }
      case 'LIBRARY_ADD_BOOKMARK': {
        await controller.bookmark({ note: boundText(message.note || '', 500) });
        return withStatus();
      }
      case 'LIBRARY_SET_REMEMBER_VOLUMES':
        return withStatus({ librarySettings: await settings.setRemember(message.value === true) });
      case 'LIBRARY_DELETE_SITE_PROFILE':
        return withStatus({ librarySettings: await settings.deleteProfile(boundText(message.origin || '', 300)) });
      case 'LIBRARY_UPDATE_SITE_PROFILE':
        return withStatus({
          librarySettings: await settings.updateProfile(boundText(message.origin || '', 300), {
            originalVolume: message.originalVolume ?? null,
            dubbedVolume: message.dubbedVolume ?? null
          })
        });
      case 'LIBRARY_UPDATE_NOTES': {
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        setNotes(record, boundText(message.notes ?? '', MAX_NOTE_LENGTH, 'الملاحظات'));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'LIBRARY_DELETE_BOOKMARK': {
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        removeBookmark(record, requireId(message.bookmarkId, 'معرّف العلامة'));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'LIBRARY_UPDATE_BOOKMARK': {
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        const bookmarkId = requireId(message.bookmarkId, 'معرّف العلامة');
        const exists = record.bookmarks.find((item) => item.id === bookmarkId);
        if (!exists) throw new Error('لم يتم العثور على العلامة.');
        updateBookmarkNote(record, bookmarkId, boundText(message.note ?? '', 500));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'LIBRARY_IMPORT_BACKUP': {
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

      default:
        return { ok: false, error: 'طلب المكتبة غير معروف.' };
    }
  };
}
