import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearchText,
  searchSessions,
  searchTranscriptRows,
  sessionSummary
} from '../src/shared/plus-search.js';
import { createDraft, appendCaption, finalizeDraft } from '../src/shared/plus-session.js';

function makeSession({ id, title = '', notes = '', updatedAt = 0, target = [], source = [], bookmarks = [] }) {
  return {
    id,
    title,
    notes,
    updatedAt,
    createdAt: updatedAt,
    durationMs: 0,
    siteOrigin: '',
    pageUrl: '',
    sourceSegments: source,
    targetSegments: target,
    bookmarks
  };
}

test('normalizeSearchText strips Arabic diacritics, tatweel and unifies letter forms', () => {
  assert.equal(normalizeSearchText('مُبَارَك'), normalizeSearchText('مبارك'));
  assert.equal(normalizeText('العـالم'), normalizeText('العالم'));
  assert.equal(normalizeSearchText('أحمد'), normalizeSearchText('احمد'));
  assert.equal(normalizeSearchText('علي'), normalizeSearchText('على'));
  assert.equal(normalizeSearchText('مدرسة'), normalizeSearchText('مدرسه'));
  assert.equal(normalizeSearchText('Hello, WORLD!'), 'hello world');
  assert.equal(normalizeSearchText('  multi   space  '), 'multi space');
});

function normalizeText(value) {
  return normalizeSearchText(value);
}

test('empty query returns all sessions newest-first', () => {
  const results = searchSessions([
    makeSession({ id: 'old', updatedAt: 1 }),
    makeSession({ id: 'new', updatedAt: 9 }),
    makeSession({ id: 'mid', updatedAt: 5 })
  ], '');
  assert.deepEqual(results.map((s) => s.id), ['new', 'mid', 'old']);
});

test('search matches Arabic target transcripts across diacritics', () => {
  const sessions = [
    makeSession({ id: 'hit', target: [{ text: 'الترجمة الآلية العربية', startMs: 0, endMs: 1 }] }),
    makeSession({ id: 'miss', target: [{ text: 'شيء آخر تماماً', startMs: 0, endMs: 1 }] })
  ];
  const results = searchSessions(sessions, 'الترجمه'); // ta-marbuta variant
  assert.deepEqual(results.map((s) => s.id), ['hit']);
});

test('search matches English source transcripts case-insensitively', () => {
  const sessions = [
    makeSession({ id: 'hit', source: [{ text: 'The quick brown fox', startMs: 0, endMs: 1 }] })
  ];
  assert.deepEqual(searchSessions(sessions, 'QUICK').map((s) => s.id), ['hit']);
  assert.deepEqual(searchSessions(sessions, 'slow').map((s) => s.id), []);
});

test('search matches titles, notes and bookmark notes', () => {
  const sessions = [
    makeSession({ id: 'title', title: 'محاضرة الذكاء الاصطناعي' }),
    makeSession({ id: 'note', notes: 'مراجعة cornerstone الحلقة' }),
    makeSession({ id: 'bmk', bookmarks: [{ id: 'b', atMs: 1, note: 'نقطة مهمة', createdAt: 1 }] })
  ];
  assert.deepEqual(searchSessions(sessions, 'محاضرة').map((s) => s.id), ['title']);
  assert.deepEqual(searchSessions(sessions, 'cornerstone').map((s) => s.id), ['note']);
  assert.deepEqual(searchSessions(sessions, 'نقطه مهمه').map((s) => s.id), ['bmk']);
});

test('multi-term queries require every term (AND)', () => {
  const sessions = [
    makeSession({ id: 'both', source: [{ text: 'deep learning models', startMs: 0, endMs: 1 }] }),
    makeSession({ id: 'one', source: [{ text: 'deep water', startMs: 0, endMs: 1 }] })
  ];
  assert.deepEqual(searchSessions(sessions, 'deep learning').map((s) => s.id), ['both']);
});

test('open-session transcript search matches Arabic text such as الأعمال', () => {
  const rows = [
    { source: 'Business planning', target: 'تخطيط الأعمال وتطويرها' },
    { source: 'A different topic', target: 'موضوع مختلف' }
  ];
  assert.deepEqual(searchTranscriptRows(rows, 'الأعمال'), [rows[0]]);
  assert.deepEqual(searchTranscriptRows(rows, 'اَلْأَعْمَال'), [rows[0]]);
  assert.deepEqual(searchTranscriptRows(rows, 'business تطويرها'), [rows[0]]);
  assert.deepEqual(searchTranscriptRows(rows, ''), rows);
});

test('sessionSummary exposes card fields with line counts', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'a.', atMs: 1 });
  appendCaption(draft, { channel: 'target', text: 'ب.', atMs: 2 });
  finalizeDraft(draft, { endedAt: 30_000 });
  const summary = sessionSummary({ ...draft, siteOrigin: 'youtube.com' });
  assert.equal(summary.lineCount, 2);
  assert.equal(summary.durationMs, 30_000);
  assert.equal(summary.siteOrigin, 'youtube.com');
  assert.equal(summary.title, 'youtube.com');
});
