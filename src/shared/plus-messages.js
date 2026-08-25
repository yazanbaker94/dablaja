// Plus message boundary — one central, adapter-injected handler the service
// worker delegates to. Every PAID mutation passes through requirePlusEntitlement();
// read/export/delete of already-owned data stays available while locked so user
// data is never held hostage. UI disabled states are never trusted.
//
// Every response uses one consistent shape:
//   { ok, plus: { entitlement, rememberVolumes, siteProfiles },
//     draft: <active draft summary or null>, storageWarning }

import { mergeSessions, parseBackup } from './plus-backup.js';
import { removeBookmark, setNotes, updateBookmarkNote } from './plus-session.js';
import { verifyLicenseToken, PLUS_LICENSE_PUBLIC_KEY_B64 } from './plus-entitlement.js';

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
  settings,          // { get(), setRemember(v), deleteProfile(origin) }
  entitlement,       // async () => { entitlement: { plusEnabled, ... }, ... } (full settings)
  // Ed25519 public key (base64) for verifying signed license tokens.
  // Defaults to the key embedded in plus-entitlement.js; tests inject their own.
  tokenPublicKey,
  getExpectedInstallId = null // async () => string, trusted install ID from storage.local, never from UI
} = {}) {
  if (!controller || !library || !settings || typeof entitlement !== 'function') {
    throw new Error('Plus message handler requires controller, library, settings and entitlement.');
  }
  const licensePublicKey = typeof tokenPublicKey === 'string' ? tokenPublicKey : PLUS_LICENSE_PUBLIC_KEY_B64;

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

  async function requireSessionSaveCapacity(sessionId) {
    const resolved = await entitlement().catch(() => null);
    if (resolved?.entitlement?.plusEnabled === true) return;
    const existing = await library.list();
    // A free user may create one saved session and may always update that same
    // record. Existing records from an older build remain readable/editable;
    // Plus never holds already-owned local data hostage.
    if (existing.some((record) => record?.id === sessionId)) return;
    if (existing.length >= 1) {
      const error = new Error('النسخة المجانية تتيح حفظ جلسة واحدة. احذف الجلسة الحالية أو رقِّ إلى Plus لحفظ حتى 500 جلسة.');
      error.code = 'upgrade_required';
      throw error;
    }
  }

  async function fullStatus() {
    const [plus, draftStatus] = await Promise.all([
      entitlement().catch(() => null),
      Promise.resolve().then(() => controller.status())
    ]);
    return {
      plus: plus || { entitlement: { plusEnabled: false, state: 'locked', label: '' }, rememberVolumes: false, siteProfiles: [] },
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

      // ---- Session & Profile mutations (gated by tier limits) ----
      case 'PLUS_SAVE_ACTIVE': {
        const active = controller.status()?.active;
        if (!active?.id) throw new Error('لا توجد جلسة نشطة للحفظ.');
        await requireSessionSaveCapacity(active.id);
        return withStatus({ saved: await controller.save({ title: boundText(message.title || '', MAX_TITLE_LENGTH) }) });
      }
      case 'PLUS_SAVE_UNSAVED': {
        const draftId = requireId(message.draftId, 'معرّف الجلسة');
        await requireSessionSaveCapacity(draftId);
        return withStatus({
          saved: await controller.saveUnsaved(draftId, {
            title: boundText(message.title || '', MAX_TITLE_LENGTH)
          })
        });
      }
      case 'PLUS_ADD_BOOKMARK': {
        const resolved = await entitlement().catch(() => null);
        const isFree = !resolved?.entitlement?.plusEnabled;
        const currentDraft = controller.status()?.active;
        if (isFree && (currentDraft?.bookmarkCount || 0) >= 1) {
          const err = new Error('الخطة المجانية تتيح حفظ لحظة واحدة. قم بالترقية إلى Plus لحفظ حتى 100 علامة لكل جلسة.');
          err.code = 'upgrade_required';
          throw err;
        }
        await controller.bookmark({ note: boundText(message.note || '', 500) });
        return withStatus();
      }
      case 'PLUS_SET_REMEMBER_VOLUMES':
        return withStatus({ plus: await settings.setRemember(message.value === true) });
      case 'PLUS_DELETE_SITE_PROFILE':
        return withStatus({ plus: await settings.deleteProfile(boundText(message.origin || '', 300)) });
      case 'PLUS_UPDATE_SITE_PROFILE':
        return withStatus({
          plus: await settings.updateProfile(boundText(message.origin || '', 300), {
            originalVolume: message.originalVolume ?? null,
            dubbedVolume: message.dubbedVolume ?? null
          })
        });
      case 'PLUS_UPDATE_NOTES': {
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        setNotes(record, boundText(message.notes ?? '', MAX_NOTE_LENGTH, 'الملاحظات'));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'PLUS_DELETE_BOOKMARK': {
        const sessionId = requireId(message.sessionId, 'معرّف الجلسة');
        const record = await library.get(sessionId);
        if (!record) throw new Error('لم يتم العثور على الجلسة المطلوبة.');
        removeBookmark(record, requireId(message.bookmarkId, 'معرّف العلامة'));
        const updated = await library.put(record);
        return withStatus({ session: updated });
      }
      case 'PLUS_UPDATE_BOOKMARK': {
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

      // ---- License Activation / Verification ----
      case 'PLUS_ACTIVATE_LICENSE': {
        // Only a signed token (dpl1…) whose Ed25519 signature verifies and whose
        // iid matches the current installation may unlock Plus. Legacy records
        // and plain objects are never trusted.
        const token = typeof message.token === 'string' ? message.token : '';
        if (!token) throw new Error('سجل الترخيص غير صالح أو غير موثوق.');
        let expectedInstallId = null;
        if (typeof getExpectedInstallId === 'function') {
          try { expectedInstallId = await getExpectedInstallId(); } catch { expectedInstallId = null; }
        }
        // Never trust expectedInstallId from UI message
        const verified = await verifyLicenseToken(token, { expectedInstallId, publicKeyB64: licensePublicKey });
        if (!verified) throw new Error('رمز الترخيص غير صالح أو منتهي.');
        const updated = await settings.setLicense(verified);
        return withStatus({ plus: updated });
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
