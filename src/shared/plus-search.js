// Search across saved Plus sessions: titles, notes, bookmarks and both
// transcripts, with Arabic-aware normalization.

import { transcriptLineCount } from './plus-session.js';

const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

export function normalizeSearchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sessionHaystack(session) {
  const parts = [
    session.title,
    session.notes,
    session.siteOrigin
  ];
  for (const bookmark of session.bookmarks || []) parts.push(bookmark.note);
  for (const segment of session.sourceSegments || []) parts.push(segment.text);
  for (const segment of session.targetSegments || []) parts.push(segment.text);
  return normalizeSearchText(parts.filter(Boolean).join(' \u0000 '));
}

// Returns sessions matching every whitespace-separated term, newest first.
export function searchSessions(sessions, query) {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  if (!terms.length) {
    return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return list
    .filter((session) => {
      const haystack = sessionHaystack(session);
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Contextual search for the open session detail. Rows are already aligned
// bilingual units; match either language with the same Arabic-aware rules as
// the library-wide search. Returning all rows for an empty query keeps the
// renderer deterministic.
export function searchTranscriptRows(rows, query) {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!terms.length) return list;
  return list.filter((row) => {
    const haystack = normalizeSearchText(`${row.source || ''} ${row.target || ''}`);
    return terms.every((term) => haystack.includes(term));
  });
}

const PLACEHOLDER_TITLES = new Set(['', 'جلسة دبلجة']);

export function sessionSummary(session) {
  // Fallback order: actual sanitized title → hostname without www →
  // «جلسة بدون عنوان». A generic placeholder must not hide a real hostname.
  const host = String(session.siteOrigin || '').replace(/^www\./, '');
  const rawTitle = String(session.title || '');
  const title = PLACEHOLDER_TITLES.has(rawTitle)
    ? (host || 'جلسة بدون عنوان')
    : rawTitle;
  return {
    id: session.id,
    title,
    siteOrigin: session.siteOrigin || '',
    pageUrl: session.pageUrl || '',
    updatedAt: session.updatedAt || session.createdAt || 0,
    durationMs: session.durationMs || 0,
    lineCount: transcriptLineCount(session),
    bookmarkCount: (session.bookmarks || []).length,
    hasNotes: Boolean(session.notes)
  };
}
