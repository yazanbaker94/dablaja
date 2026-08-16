// IndexedDB wrapper for saved Plus sessions. Local-only by design: no
// sync, no network, nothing leaves the device. Logic (validation, bounds,
// merging) lives in the pure plus-session/plus-backup modules.

import { PLUS_LIMITS, validateSessionRecord } from './plus-session.js';

const DB_NAME = 'dablaja-plus';
const DB_VERSION = 1;
const STORE = 'sessions';

export const SAVED_SESSION_LIMIT_MESSAGE =
  'وصلت إلى الحد الأقصى للجلسات المحفوظة (500). صدّر نسخة احتياطية أو احذف جلسات قديمة لإفساح المجال.';

// Pure decision for the record cap: updating an existing record is always
// allowed; creating a new one beyond MAX_SAVED_SESSIONS is rejected.
export function decidePut({ exists, count, limit = PLUS_LIMITS.MAX_SAVED_SESSIONS } = {}) {
  if (exists === true) return { ok: true };
  if (Number.isFinite(count) && count >= limit) {
    return { ok: false, error: SAVED_SESSION_LIMIT_MESSAGE };
  }
  return { ok: true };
}

// Deterministic batch planning: dedupe input by id (last wins), then admit
// records that already exist (updates) or fit the remaining capacity in
// input order. Admitted records are split into NEW writes versus UPDATE
// writes so callers can report truthful counts. Returns
// { admitted, admittedNew, admittedUpdates, rejected } without touching the
// database.
export function planBatchInsert(records, existingKeys, currentCount, limit = PLUS_LIMITS.MAX_SAVED_SESSIONS) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.id) byId.set(record.id, record);
  }
  const existing = new Set(Array.isArray(existingKeys) ? existingKeys : []);
  let count = Number.isFinite(currentCount) ? currentCount : 0;
  const admitted = [];
  const admittedNew = [];
  const admittedUpdates = [];
  const rejected = [];
  for (const record of byId.values()) {
    const isUpdate = existing.has(record.id);
    const decision = decidePut({ exists: isUpdate, count, limit });
    if (decision.ok) {
      if (!isUpdate) {
        count += 1;
        admittedNew.push(record);
      } else {
        admittedUpdates.push(record);
      }
      admitted.push(record);
    } else {
      rejected.push(record);
    }
  }
  return { admitted, admittedNew, admittedUpdates, rejected };
}

let dbPromise = null;

export function openPlusDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another context (e.g. a newer version) upgraded the database: drop
      // the cached connection so the next call reopens cleanly.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('تعذر فتح قاعدة البيانات المحلية.'));
    };
  });
  return dbPromise;
}

// Resolves a single IDBRequest to its result — withStore callbacks must use
// this instead of returning raw IDBRequest objects.
function settle(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('فشل طلب قاعدة البيانات.'));
  });
}

async function withStore(mode, run) {
  const db = await openPlusDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let outcome;
    let failed = false;
    try {
      outcome = run(store, settle);
    } catch (error) {
      failed = true;
      reject(error);
      return;
    }
    Promise.resolve(outcome)
      .then((value) => {
        if (failed) return;
        tx.oncomplete = () => resolve(value);
      })
      .catch((error) => {
        failed = true;
        try {
          tx.abort();
        } catch {}
        reject(error);
      });
    tx.onerror = () => {
      if (!failed) reject(tx.error || new Error('فشلت العملية على البيانات المحلية.'));
    };
    tx.onabort = () => {
      if (!failed) reject(tx.error || new Error('أُلغيت العملية على البيانات المحلية.'));
    };
  });
}

export async function putSavedSession(record) {
  const clean = validateSessionRecord(record);
  if (!clean) throw new Error('سجل الجلسة غير صالح للحفظ.');
  // Existence check, count check AND the put run inside ONE readwrite
  // transaction: IndexedDB serializes readwrite transactions per store, so
  // two concurrent new saves at count 499 cannot both succeed.
  const db = await openPlusDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        tx.abort();
      } catch {}
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    tx.onerror = () => fail(tx.error || new Error('فشلت العملية على البيانات المحلية.'));
    tx.onabort = () => fail(tx.error || new Error('أُلغيت العملية على البيانات المحلية.'));
    Promise.all([
      settle(store.get(clean.id)),
      settle(store.count())
    ])
      .then(([existing, count]) => {
        const decision = decidePut({ exists: Boolean(existing), count });
        if (!decision.ok) {
          const error = new Error(decision.error);
          error.code = 'saved_session_limit';
          fail(error);
          return;
        }
        store.put(clean);
        tx.oncomplete = () => succeed(clean);
      })
      .catch(fail);
  });
}

export async function getSavedSession(id) {
  const record = await withStore('readonly', (store) => settle(store.get(String(id))));
  return record ? validateSessionRecord(record) : null;
}

export async function listSavedSessions() {
  const records = await withStore('readonly', (store) => settle(store.getAll()));
  return (Array.isArray(records) ? records : [])
    .map((record) => validateSessionRecord(record))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteSavedSession(id) {
  await withStore('readwrite', (store) => store.delete(String(id)));
  return true;
}

export async function clearSavedSessions() {
  await withStore('readwrite', (store) => store.clear());
  return true;
}

// Atomic batch import: reads existing keys/count and writes every admitted
// record inside ONE read/write transaction. Capacity is determined up front
// (deduped, deterministic) so written/rejected counts are exact, with new
// writes and updates distinguished for truthful reporting.
export async function putSavedSessionBatch(records, { limit = PLUS_LIMITS.MAX_SAVED_SESSIONS } = {}) {
  const cleanList = (Array.isArray(records) ? records : [])
    .map((record) => validateSessionRecord(record))
    .filter(Boolean);
  if (!cleanList.length) return { written: 0, rejected: 0, writtenNew: 0, writtenUpdates: 0 };

  const db = await openPlusDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const plan = { newRecords: [], updates: [], rejected: [] };
    Promise.all([
      settle(store.getAllKeys()),
      settle(store.count())
    ])
      .then(([keys, count]) => {
        const planned = planBatchInsert(cleanList, keys, count, limit);
        plan.newRecords = planned.admittedNew;
        plan.updates = planned.admittedUpdates;
        plan.rejected = planned.rejected;
        for (const record of planned.admitted) store.put(record);
      })
      .catch((error) => {
        try {
          tx.abort();
        } catch {}
        reject(error);
      });

    tx.oncomplete = () => resolve({
      written: plan.newRecords.length + plan.updates.length,
      rejected: plan.rejected.length,
      writtenNew: plan.newRecords.length,
      writtenUpdates: plan.updates.length
    });
    tx.onerror = () => reject(tx.error || new Error('فشل استيراد الدفعة.'));
    tx.onabort = () => reject(tx.error || new Error('أُلغي استيراد الدفعة.'));
  });
}

export async function estimatePlusStorage() {
  if (navigator?.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    return {
      usageBytes: Number(estimate.usage) || 0,
      quotaBytes: Number(estimate.quota) || 0
    };
  }
  return { usageBytes: 0, quotaBytes: 0 };
}
