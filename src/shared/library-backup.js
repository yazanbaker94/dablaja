// Local library backup: creation, validation and merge-on-import.
// A backup is a JSON document of saved sessions. Import must never corrupt or
// delete existing data and must never silently drop a valid record: records
// are validated and deduplicated deterministically; capacity decisions are
// left to the atomic database layer so rejections are reported truthfully.

import {
  LIBRARY_SCHEMA_VERSION,
  utf8ByteLength,
  validateSessionRecord
} from './library-session.js';

export const BACKUP_KIND = 'dablaja-plus-backup';
export const MAX_BACKUP_BYTES = 24 * 1024 * 1024;

export function createBackup(sessions, { exportedAt = Date.now() } = {}) {
  const list = (Array.isArray(sessions) ? sessions : [])
    .map((session) => validateSessionRecord(session))
    .filter(Boolean);
  const backup = {
    app: 'dablaja',
    kind: BACKUP_KIND,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    exportedAt: new Date(Number(exportedAt) || Date.now()).toISOString(),
    sessionCount: list.length,
    sessions: list
  };
  return JSON.stringify(backup, null, 2);
}

// Parses raw backup text. Returns { ok: true, sessions, rejected } or
// { ok: false, error }. Size is enforced on real UTF-8 bytes, not characters.
// Valid sessions are NEVER trimmed here — capacity rejections belong to the
// database layer so they can be reported accurately.
export function parseBackup(rawText, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text.trim()) return { ok: false, error: 'الملف فارغ.' };
  if (utf8ByteLength(text) > maxBytes) {
    return { ok: false, error: 'حجم النسخة الاحتياطية أكبر من المسموح.' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'ملف غير صالح: ليس JSON سليماً.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'بنية النسخة الاحتياطية غير صالحة.' };
  }
  if (parsed.app !== 'dablaja' || parsed.kind !== BACKUP_KIND) {
    return { ok: false, error: 'هذا الملف ليس نسخة احتياطية من مكتبة dablaja.' };
  }
  if (parsed.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
    return { ok: false, error: 'إصدار النسخة الاحتياطية غير مدعوم.' };
  }
  if (!Array.isArray(parsed.sessions)) {
    return { ok: false, error: 'قائمة الجلسات مفقودة من النسخة الاحتياطية.' };
  }
  const sessions = [];
  let rejected = 0;
  for (const record of parsed.sessions) {
    const clean = validateSessionRecord(record);
    if (clean) sessions.push(clean);
    else rejected += 1;
  }
  if (!sessions.length) {
    return { ok: false, error: 'لا توجد جلسات صالحة في النسخة الاحتياطية.' };
  }
  return { ok: true, sessions, rejected };
}

// Deterministically deduplicates imported records by id (the last record in
// the array wins). Superseded duplicates are counted, never double-reported.
export function dedupeSessionsById(sessions) {
  const byId = new Map();
  let superseded = 0;
  for (const record of Array.isArray(sessions) ? sessions : []) {
    if (!record?.id) continue;
    if (byId.has(record.id)) superseded += 1;
    byId.set(record.id, record);
  }
  return { sessions: [...byId.values()], superseded };
}

// Merges deduped imported sessions into existing ones. Same id → the newer
// updatedAt record wins. Existing sessions are never removed and new records
// are NOT capacity-trimmed here — the atomic database layer reports those
// rejections so nothing is silently dropped.
// `newRecords`/`updatedRecords` are exactly the records that need writing;
// unchanged existing records are left untouched by import.
export function mergeSessions(existing, imported) {
  const current = new Map();
  for (const session of Array.isArray(existing) ? existing : []) {
    if (session?.id) current.set(session.id, session);
  }
  const { sessions: deduped, superseded } = dedupeSessionsById(imported);
  let added = 0;
  let updated = 0;
  const newRecords = [];
  const updatedRecords = [];
  for (const session of deduped) {
    const clean = validateSessionRecord(session);
    if (!clean) continue;
    const previous = current.get(clean.id);
    if (previous) {
      if ((clean.updatedAt || 0) > (previous.updatedAt || 0)) {
        current.set(clean.id, clean);
        updatedRecords.push(clean);
        updated += 1;
      }
    } else {
      current.set(clean.id, clean);
      newRecords.push(clean);
      added += 1;
    }
  }
  return {
    sessions: [...current.values()],
    newRecords,
    updatedRecords,
    added,
    updated,
    superseded
  };
}
