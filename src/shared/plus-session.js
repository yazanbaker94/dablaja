// Plus session draft model — pure functions, no chrome.* access.
// A draft accumulates the English source and Arabic target transcripts that
// Gemini already returns during a live dubbing session. Nothing here performs
// network calls, stores audio, or touches the API key.

import { mergeCaptionText, shouldFinalizeCaption } from './caption-utils.js';
import { normalizeOrigin } from './normalize-origin.js';

export const PLUS_SCHEMA_VERSION = 1;

export const PLUS_LIMITS = Object.freeze({
  MAX_TITLE_LENGTH: 200,
  MAX_NOTE_LENGTH: 2000,
  MAX_URL_LENGTH: 2000,
  MAX_ORIGIN_LENGTH: 300,
  MAX_SEGMENT_TEXT: 2000,
  MAX_SEGMENTS_PER_CHANNEL: 4000,
  MAX_BOOKMARKS_PER_SESSION: 100,
  MAX_BOOKMARK_NOTE: 500,
  MAX_SAVED_SESSIONS: 500,
  MAX_DRAFTS: 3,
  // Session-storage budget: chrome.storage.session quota is 10 MB; stay well
  // below it across the active draft AND every unsaved draft combined. The
  // active-draft cap sits below the 600k-char text ceiling (~1.2 MB Arabic)
  // so byte truncation is reachable, not dead, code.
  SESSION_STORAGE_BUDGET_BYTES: 5_000_000,
  ACTIVE_DRAFT_MAX_BYTES: 1_000_000,
  // Conservative total text ceiling per session (Arabic ≈ 2 bytes/char UTF-8).
  MAX_SESSION_TEXT_TOTAL: 600_000
});

export const CHANNELS = Object.freeze(['source', 'target']);

export function sanitizeText(value, maxLength) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, Math.max(0, maxLength));
}

export function sanitizeUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const parsed = new URL(text);
    // Credentials are never stored; fragments carry no replay value.
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString().slice(0, PLUS_LIMITS.MAX_URL_LENGTH);
  } catch {
    return '';
  }
}

// Multiline sanitizer for notes: preserves line breaks, strips control
// characters, and collapses spaces/tabs per line without joining lines.
export function sanitizeMultilineText(value, maxLength = Infinity) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limit = Number.isFinite(maxLength) ? maxLength : Infinity;
  return text.slice(0, Math.max(0, limit));
}

export function sanitizeOrigin(value) {
  return normalizeOrigin(value).slice(0, PLUS_LIMITS.MAX_ORIGIN_LENGTH);
}

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value) {
  if (!value) return 0;
  return utf8Encoder.encode(String(value)).length;
}

export function sessionStorageBytes(record) {
  if (!record) return 0;
  return utf8ByteLength(JSON.stringify(record));
}

function newId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

// Title fallback order: sanitized page title → hostname → «جلسة دبلجة».
export function sessionTitleOrDefault(title, siteOrigin = '') {
  const clean = sanitizeText(title, PLUS_LIMITS.MAX_TITLE_LENGTH);
  if (clean) return clean;
  const host = sanitizeOrigin(siteOrigin).replace(/^www\./, '');
  if (host) return host;
  return 'جلسة دبلجة';
}

export function createDraft({ startedAt = Date.now(), siteOrigin = '', title = '', pageUrl = '' } = {}) {
  const origin = sanitizeOrigin(siteOrigin);
  return {
    schemaVersion: PLUS_SCHEMA_VERSION,
    id: newId('plussession'),
    // Temporary metadata (session-storage only). Copied into the permanent
    // IndexedDB record solely on explicit save or enabled autosave.
    title: sessionTitleOrDefault(title, origin),
    pageUrl: sanitizeUrl(pageUrl),
    siteOrigin: origin,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now(),
    endedAt: null,
    durationMs: 0,
    sourceSegments: [],
    targetSegments: [],
    bookmarks: [],
    // Tombstones for deleted bookmarks: { [bookmarkId]: deletedAtMs }
    bookmarkTombstones: {},
    notes: '',
    notesUpdatedAt: 0,
    originalVolume: null,
    dubbedVolume: null,
    _pending: { source: null, target: null }
  };
}

function channelState(draft, channel) {
  return channel === 'source' ? draft.sourceSegments : draft.targetSegments;
}

function pendingState(draft, channel) {
  return draft._pending?.[channel] ?? null;
}

function estimateTotalCharacters(draft) {
  let total = 0;
  for (const channel of CHANNELS) {
    for (const segment of channelState(draft, channel)) total += segment.text.length;
    const pending = pendingState(draft, channel);
    if (pending) total += pending.text.length;
  }
  return total;
}

function normalizeTurnId(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function pushSegment(draft, channel, text, startMs, endMs, speaker = '', turnId = null) {
  const segments = channelState(draft, channel);
  const previous = segments[segments.length - 1];
  const clean = sanitizeText(text, PLUS_LIMITS.MAX_SEGMENT_TEXT);
  const roundedEnd = Math.max(0, Math.round(Number(endMs) || 0));
  if (!clean) return;
  // Duplicate suppression after reconnects: Gemini may re-emit an identical
  // finalized turn when the session resumes. Same non-null turnId is always
  // a genuine duplicate; for legacy segments without turn ids, only exact
  // repeats within ~1 s are dropped so genuinely repeated short utterances
  // ("Yeah." … "Yeah.") later in the session survive.
  if (
    previous &&
    previous.text === clean &&
    ((previous.turnId != null && normalizeTurnId(turnId) === previous.turnId) ||
      Math.abs(previous.endMs - roundedEnd) <= 1000)
  ) {
    return;
  }
  if (segments.length >= PLUS_LIMITS.MAX_SEGMENTS_PER_CHANNEL) {
    segments.shift();
  }
  const id = newId('seg');
  segments.push({
    id,
    startMs: Math.max(0, Math.round(Number(startMs) || 0)),
    endMs: Math.max(0, Math.round(Number(endMs) || Number(startMs) || 0)),
    text: clean,
    speaker: sanitizeText(speaker, 40),
    turnId: normalizeTurnId(turnId)
  });
}

// Appends one caption event (already parsed by protocol.js) to the draft.
// `atMs` is the caption time relative to the session start, in milliseconds.
export function appendCaption(draft, {
  channel,
  text,
  final = false,
  atMs = 0,
  speaker = '',
  turnId = null
}) {
  if (!draft || !CHANNELS.includes(channel)) return draft;
  const clean = sanitizeText(text, PLUS_LIMITS.MAX_SEGMENT_TEXT);
  const relativeMs = Math.max(0, Math.round(Number(atMs) || 0));
  draft.updatedAt = Date.now();

  if (!clean) {
    if (final === true) finalizePending(draft, channel, relativeMs);
    return draft;
  }

  if (estimateTotalCharacters(draft) > PLUS_LIMITS.MAX_SESSION_TEXT_TOTAL) return draft;

  const normalizedTurnId = normalizeTurnId(turnId);
  let pending = pendingState(draft, channel);
  // A new Gemini generation must never be merged into an unfinished caption
  // from the previous generation. This also preserves exact bilingual
  // pairing metadata for the Plus library.
  if (
    pending &&
    pending.turnId != null &&
    normalizedTurnId != null &&
    pending.turnId !== normalizedTurnId
  ) {
    finalizePending(draft, channel, relativeMs);
    pending = null;
  }
  if (pending) {
    pending.text = sanitizeText(
      mergeCaptionText(pending.text, clean),
      PLUS_LIMITS.MAX_SEGMENT_TEXT
    );
    if (!pending.speaker && speaker) pending.speaker = sanitizeText(speaker, 40);
  } else {
    draft._pending = draft._pending || {};
    draft._pending[channel] = {
      text: clean,
      startMs: relativeMs,
      speaker: sanitizeText(speaker, 40),
      turnId: normalizedTurnId
    };
  }
  if (final === true || shouldFinalizeCaption(pendingState(draft, channel)?.text)) {
    finalizePending(draft, channel, relativeMs);
  }
  return draft;
}

function finalizePending(draft, channel, atMs) {
  const pending = pendingState(draft, channel);
  if (draft._pending) draft._pending[channel] = null;
  if (!pending?.text) return;
  pushSegment(
    draft,
    channel,
    pending.text,
    pending.startMs,
    atMs,
    pending.speaker,
    pending.turnId
  );
}

// Flushes any interim text into final segments. Must run when a session stops.
export function finalizeDraft(draft, { endedAt = Date.now() } = {}) {
  if (!draft) return draft;
  const end = Number.isFinite(Number(endedAt)) ? Number(endedAt) : Date.now();
  const durationMs = Math.max(0, end - draft.startedAt);
  for (const channel of CHANNELS) {
    finalizePending(draft, channel, durationMs);
  }
  draft._pending = { source: null, target: null };
  draft.endedAt = end;
  draft.durationMs = durationMs;
  draft.updatedAt = Date.now();
  return draft;
}

// Snapshot for saving mid-session: the live draft keeps running untouched.
export function snapshotDraft(draft, { endedAt = Date.now() } = {}) {
  if (!draft) return null;
  const copy = structuredClone({
    ...draft,
    _pending: { source: draft._pending?.source ?? null, target: draft._pending?.target ?? null }
  });
  return finalizeDraft(copy, { endedAt });
}

export function validateBookmarkInput({ atMs, note = '' } = {}) {
  const at = Number(atMs);
  if (!Number.isFinite(at) || at < 0 || at > 24 * 60 * 60 * 1000) return null;
  const cleanNote = sanitizeText(note, PLUS_LIMITS.MAX_BOOKMARK_NOTE);
  return { atMs: Math.round(at), note: cleanNote };
}

export function addBookmark(draft, { atMs, note = '', createdAt = Date.now() } = {}) {
  if (!draft) return draft;
  const validated = validateBookmarkInput({ atMs, note });
  if (!validated) return draft;
  if (draft.bookmarks.length >= PLUS_LIMITS.MAX_BOOKMARKS_PER_SESSION) {
    const removed = draft.bookmarks.shift();
    if (removed?.id) {
      draft.bookmarkTombstones = draft.bookmarkTombstones || {};
      draft.bookmarkTombstones[removed.id] = Date.now();
    }
  }
  const now = Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now();
  draft.bookmarks.push({
    id: newId('bmk'),
    atMs: validated.atMs,
    note: validated.note,
    createdAt: now,
    updatedAt: now
  });
  draft.bookmarks.sort((a, b) => a.atMs - b.atMs);
  draft.updatedAt = Date.now();
  return draft;
}

export function removeBookmark(draft, bookmarkId) {
  if (!draft) return draft;
  const cleanId = String(bookmarkId || '').trim();
  if (!cleanId) return draft;
  const before = draft.bookmarks.length;
  draft.bookmarks = draft.bookmarks.filter((bookmark) => bookmark.id !== cleanId);
  if (draft.bookmarks.length !== before) {
    draft.bookmarkTombstones = draft.bookmarkTombstones || {};
    draft.bookmarkTombstones[cleanId] = Date.now();
  }
  draft.updatedAt = Date.now();
  return draft;
}

export function updateBookmarkNote(draft, bookmarkId, note) {
  if (!draft) return draft;
  const cleanId = String(bookmarkId || '').trim();
  const bookmark = draft.bookmarks.find((b) => b.id === cleanId);
  if (!bookmark) return draft;
  bookmark.note = sanitizeText(note, PLUS_LIMITS.MAX_BOOKMARK_NOTE);
  bookmark.updatedAt = Date.now();
  draft.updatedAt = Date.now();
  return draft;
}

export function setNotes(draft, notes) {
  if (!draft) return draft;
  // Notes are the one multiline field; never collapse their line breaks.
  draft.notes = sanitizeMultilineText(notes, PLUS_LIMITS.MAX_NOTE_LENGTH);
  draft.notesUpdatedAt = Date.now();
  draft.updatedAt = Date.now();
  return draft;
}

// Deterministic merge for live vs saved records. Preserves newer notes and
// bookmark edits via updatedAt, and respects tombstones so deleted bookmarks
// are never resurrected. Used by finish() and restore().
export function mergeDraftWithSaved(live, saved) {
  if (!live) return saved || null;
  if (!saved) return live;
  if (live.id !== saved.id) return live;
  const merged = structuredClone(live);
  // Notes: keep whichever has newer notesUpdatedAt
  const liveNotesAt = Number(live.notesUpdatedAt) || 0;
  const savedNotesAt = Number(saved.notesUpdatedAt) || 0;
  if (savedNotesAt > liveNotesAt && typeof saved.notes === 'string') {
    merged.notes = saved.notes;
    merged.notesUpdatedAt = saved.notesUpdatedAt;
  }
  // Tombstones: union, newer wins
  const mergedTombstones = { ...(saved.bookmarkTombstones || {}), ...(live.bookmarkTombstones || {}) };
  for (const [id, ts] of Object.entries(saved.bookmarkTombstones || {})) {
    const liveTs = live.bookmarkTombstones?.[id] || 0;
    mergedTombstones[id] = Math.max(Number(ts) || 0, Number(liveTs) || 0);
  }
  for (const [id, ts] of Object.entries(live.bookmarkTombstones || {})) {
    const savedTs = saved.bookmarkTombstones?.[id] || 0;
    mergedTombstones[id] = Math.max(Number(ts) || 0, Number(savedTs) || 0);
  }
  merged.bookmarkTombstones = mergedTombstones;
  // Bookmarks: deterministic merge by id
  const byId = new Map();
  for (const bm of [...(saved.bookmarks || []), ...(live.bookmarks || [])]) {
    if (!bm?.id) continue;
    const existing = byId.get(bm.id);
    if (!existing) {
      byId.set(bm.id, bm);
      continue;
    }
    const existingAt = Number(existing.updatedAt) || Number(existing.createdAt) || 0;
    const incomingAt = Number(bm.updatedAt) || Number(bm.createdAt) || 0;
    if (incomingAt > existingAt) byId.set(bm.id, bm);
    else if (incomingAt === existingAt && JSON.stringify(bm) > JSON.stringify(existing)) byId.set(bm.id, bm);
  }
  const mergedBookmarks = [];
  for (const [id, bm] of byId.entries()) {
    const tombAt = Number(mergedTombstones[id]) || 0;
    const bmAt = Number(bm.updatedAt) || Number(bm.createdAt) || 0;
    if (tombAt && tombAt >= bmAt) continue;
    mergedBookmarks.push(bm);
  }
  mergedBookmarks.sort((a, b) => a.atMs - b.atMs);
  // Enforce cap after merge (oldest first)
  while (mergedBookmarks.length > PLUS_LIMITS.MAX_BOOKMARKS_PER_SESSION) {
    const oldest = mergedBookmarks.shift();
    if (oldest?.id) mergedTombstones[oldest.id] = Date.now();
  }
  merged.bookmarks = mergedBookmarks;
  merged.bookmarkTombstones = mergedTombstones;
  merged.updatedAt = Math.max(Number(live.updatedAt) || 0, Number(saved.updatedAt) || 0, Date.now());
  return merged;
}

export function compactTombstones(record) {
  if (!record?.bookmarkTombstones) return record;
  // After terminal successful write, tombstones for bookmarks that no longer
  // exist can be compacted (kept bounded). For now, keep only tombstones that
  // correspond to recently deleted ids; drop stale ones older than 7 days if
  // they are not needed to prevent resurrection of currently absent bookmarks.
  // Simplified: keep tombstones for ids not present in bookmarks, drop others.
  const present = new Set((record.bookmarks || []).map((b) => b.id));
  const compacted = {};
  for (const [id, ts] of Object.entries(record.bookmarkTombstones)) {
    if (!present.has(id)) compacted[id] = ts;
  }
  record.bookmarkTombstones = compacted;
  return record;
}

export function setSessionIdentity(draft, { title = '', pageUrl = '', notes } = {}) {
  if (!draft) return draft;
  const cleanTitle = sanitizeText(title, PLUS_LIMITS.MAX_TITLE_LENGTH);
  if (cleanTitle) draft.title = cleanTitle;
  const cleanUrl = sanitizeUrl(pageUrl);
  if (cleanUrl) draft.pageUrl = cleanUrl;
  if (notes !== undefined) setNotes(draft, notes);
  draft.updatedAt = Date.now();
  return draft;
}

export function transcriptLineCount(session) {
  if (!session) return 0;
  return (session.sourceSegments?.length || 0) + (session.targetSegments?.length || 0);
}

// Storage-layer helpers ----------------------------------------------------

// Keeps the newest `keep` unsaved drafts. Starting another session must never
// silently destroy an earlier draft beyond this bound.
export function trimDrafts(drafts, keep = PLUS_LIMITS.MAX_DRAFTS) {
  const list = Array.isArray(drafts) ? drafts.filter(Boolean) : [];
  return list
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, Math.max(1, keep));
}

// Drops the OLDEST transcript segments (both channels, oldest first) until the
// draft fits `maxBytes` of serialized UTF-8. Bookmarks and notes are always
// kept — they are user-authored, not stream content. Returns
// { draft, truncated } so callers can disclose the truncation.
export function truncateDraftToByteBudget(draft, maxBytes = PLUS_LIMITS.ACTIVE_DRAFT_MAX_BYTES) {
  if (!draft) return { draft, truncated: false };
  let working = draft;
  if (sessionStorageBytes(working) <= maxBytes) return { draft: working, truncated: false };
  working.truncated = true;
  working.updatedAt = Date.now();
  // Track the serialized size incrementally: dropping a segment removes its
  // own JSON plus one separator byte. Re-stringifying the whole draft per
  // dropped segment made long sessions freeze the worker for seconds.
  let size = sessionStorageBytes(working);
  const segmentCost = (segment) => utf8ByteLength(JSON.stringify(segment)) + 1;
  while (size > maxBytes) {
    const source = working.sourceSegments || [];
    const target = working.targetSegments || [];
    const oldestSource = source[0];
    const oldestTarget = target[0];
    if (!oldestSource && !oldestTarget) break;
    if (oldestSource && (!oldestTarget || oldestSource.startMs <= oldestTarget.startMs)) {
      size -= segmentCost(oldestSource);
      source.shift();
    } else {
      size -= segmentCost(oldestTarget);
      target.shift();
    }
  }
  // The running estimate is off by at most a separator byte; verify exactly
  // once and drain the remainder if needed (rare, a few iterations).
  while (sessionStorageBytes(working) > maxBytes) {
    const source = working.sourceSegments || [];
    const target = working.targetSegments || [];
    if (!source.length && !target.length) break;
    if (source.length && (!target.length || source[0].startMs <= target[0].startMs)) source.shift();
    else target.shift();
  }
  return { draft: working, truncated: true };
}

// Trims the unsaved-draft list to the combined byte budget, preferring the
// newest drafts. Returns { drafts, dropped } so the UI can warn.
export function trimUnsavedDraftsToByteBudget(
  drafts,
  budgetBytes = PLUS_LIMITS.SESSION_STORAGE_BUDGET_BYTES
) {
  const list = Array.isArray(drafts) ? drafts.filter(Boolean) : [];
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const draft of list) {
    const size = sessionStorageBytes(draft);
    if (kept.length && used + size > budgetBytes) {
      dropped += 1;
      continue;
    }
    kept.push(draft);
    used += size;
  }
  return { drafts: kept, dropped };
}

const REQUIRED_SESSION_KEYS = ['id', 'schemaVersion', 'createdAt', 'sourceSegments', 'targetSegments'];

// Validates and bounds a session record coming from storage or an import.
// Returns a clean record or null when malformed.
export function validateSessionRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!REQUIRED_SESSION_KEYS.every((key) => key in record)) return null;
  if (record.schemaVersion !== PLUS_SCHEMA_VERSION) return null;
  if (typeof record.id !== 'string' || !/^plussession_[a-z0-9]+$/i.test(record.id)) return null;
  const cleanSegments = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((segment) => segment && typeof segment.text === 'string')
      .slice(0, PLUS_LIMITS.MAX_SEGMENTS_PER_CHANNEL)
      .map((segment, index) => ({
        id: sanitizeText(segment.id, 60) || `seg_${index}`,
        startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
        endMs: Math.max(0, Math.round(Number(segment.endMs) || Number(segment.startMs) || 0)),
        text: sanitizeText(segment.text, PLUS_LIMITS.MAX_SEGMENT_TEXT),
        speaker: sanitizeText(segment.speaker, 40),
        turnId: normalizeTurnId(segment.turnId)
      }))
      .filter((segment) => segment.text);
  };
  const bookmarks = Array.isArray(record.bookmarks)
    ? record.bookmarks
        .map((bookmark) => {
          const validated = validateBookmarkInput({ atMs: bookmark?.atMs, note: bookmark?.note });
          if (!validated) return null;
          const createdAt = Number.isFinite(Number(bookmark.createdAt)) ? Number(bookmark.createdAt) : 0;
          const updatedAt = Number.isFinite(Number(bookmark.updatedAt)) ? Number(bookmark.updatedAt) : createdAt;
          return {
            id: sanitizeText(bookmark.id, 60) || newId('bmk'),
            atMs: validated.atMs,
            note: validated.note,
            createdAt,
            updatedAt
          };
        })
        .filter(Boolean)
        .slice(0, PLUS_LIMITS.MAX_BOOKMARKS_PER_SESSION)
    : [];
  // Bookmark tombstones: { [id]: deletedAt }
  let bookmarkTombstones = {};
  if (record.bookmarkTombstones && typeof record.bookmarkTombstones === 'object' && !Array.isArray(record.bookmarkTombstones)) {
    for (const [id, ts] of Object.entries(record.bookmarkTombstones)) {
      const cleanId = sanitizeText(id, 60);
      const numeric = Number(ts);
      if (cleanId && Number.isFinite(numeric) && numeric > 0) {
        if (Object.keys(bookmarkTombstones).length < PLUS_LIMITS.MAX_BOOKMARKS_PER_SESSION * 2) {
          bookmarkTombstones[cleanId] = Math.round(numeric);
        }
      }
    }
  }
  const durationMs = Math.max(0, Math.round(Number(record.durationMs) || 0));
  const volume = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1.5 ? numeric : null;
  };
  const notes = sanitizeMultilineText(record.notes, PLUS_LIMITS.MAX_NOTE_LENGTH);
  const notesUpdatedAt = Number.isFinite(Number(record.notesUpdatedAt)) ? Math.max(0, Math.round(Number(record.notesUpdatedAt))) : 0;
  return {
    schemaVersion: PLUS_SCHEMA_VERSION,
    id: record.id,
    title: sanitizeText(record.title, PLUS_LIMITS.MAX_TITLE_LENGTH),
    pageUrl: sanitizeUrl(record.pageUrl),
    siteOrigin: sanitizeOrigin(record.siteOrigin),
    // Bounded controller metadata so reload recovery knows whether the user
    // explicitly saved this session. Only an exact boolean is trusted.
    saveRequested: record.saveRequested === true,
    truncated: record.truncated === true,
    createdAt: Math.max(0, Math.round(Number(record.createdAt) || 0)),
    updatedAt: Math.max(0, Math.round(Number(record.updatedAt) || Number(record.createdAt) || 0)),
    startedAt: Math.max(0, Math.round(Number(record.startedAt) || Number(record.createdAt) || 0)),
    endedAt: Number.isFinite(Number(record.endedAt)) ? Math.max(0, Math.round(Number(record.endedAt))) : null,
    durationMs,
    sourceSegments: cleanSegments(record.sourceSegments),
    targetSegments: cleanSegments(record.targetSegments),
    bookmarks,
    bookmarkTombstones,
    notes,
    notesUpdatedAt,
    originalVolume: volume(record.originalVolume),
    dubbedVolume: volume(record.dubbedVolume)
  };
}

export function trimSavedSessions(sessions, limit = PLUS_LIMITS.MAX_SAVED_SESSIONS) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  if (list.length <= limit) return list;
  return list
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}
