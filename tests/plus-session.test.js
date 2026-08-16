import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLUS_LIMITS,
  addBookmark,
  appendCaption,
  createDraft,
  finalizeDraft,
  removeBookmark,
  sanitizeMultilineText,
  sanitizeOrigin,
  sanitizeText,
  sanitizeUrl,
  setNotes,
  setSessionIdentity,
  snapshotDraft,
  transcriptLineCount,
  trimDrafts,
  trimSavedSessions,
  validateBookmarkInput,
  validateSessionRecord
} from '../src/shared/plus-session.js';

test('drafts start empty with session-relative timestamps and normalized origin', () => {
  const draft = createDraft({ startedAt: 1000, siteOrigin: 'https://www.YouTube.COM:443' });
  assert.equal(draft.schemaVersion, 1);
  assert.equal(draft.sourceSegments.length, 0);
  assert.equal(draft.targetSegments.length, 0);
  assert.equal(draft.bookmarks.length, 0);
  assert.ok(draft.id.startsWith('plussession_'));
  assert.equal(draft.startedAt, 1000);
  // Full HTTP(S) origins/URLs normalize to hostname(:port), matching what
  // originOf() actually produces in the service worker.
  assert.equal(draft.siteOrigin, 'www.youtube.com');
  assert.equal(draft.title, 'youtube.com');
  assert.equal(createDraft({ siteOrigin: 'youtube.com' }).siteOrigin, 'youtube.com');
  assert.equal(createDraft({ siteOrigin: '' }).title, 'جلسة دبلجة');
});

test('interim cumulative captions merge into one finalized segment', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'Hello', atMs: 1200 });
  appendCaption(draft, { channel: 'source', text: 'Hello world', atMs: 1800 });
  appendCaption(draft, { channel: 'source', text: 'Hello world today.', atMs: 2400 });
  assert.equal(draft.sourceSegments.length, 1);
  assert.equal(draft.sourceSegments[0].text, 'Hello world today.');
  assert.equal(draft.sourceSegments[0].startMs, 1200);
  assert.equal(draft.sourceSegments[0].endMs, 2400);
});

test('source and target segments stay separated per channel', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'One.', atMs: 100 });
  appendCaption(draft, { channel: 'target', text: 'واحد.', atMs: 150 });
  appendCaption(draft, { channel: 'target', text: 'واحد. اثنان.', atMs: 900 });
  appendCaption(draft, { channel: 'source', text: 'One. Two.', atMs: 950 });
  assert.deepEqual(draft.sourceSegments.map((s) => s.text), ['One.', 'One. Two.']);
  assert.deepEqual(draft.targetSegments.map((s) => s.text), ['واحد.', 'واحد. اثنان.']);
});

test('sentence punctuation finalizes a segment without an explicit final flag', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'Done!', atMs: 500 });
  appendCaption(draft, { channel: 'source', text: 'Next', atMs: 700 });
  appendCaption(draft, { channel: 'source', text: 'Next.', atMs: 900 });
  assert.equal(draft.sourceSegments.length, 2);
});

test('final flag with empty text flushes pending interim text', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'target', text: 'نص مؤقت', atMs: 400 });
  appendCaption(draft, { channel: 'target', text: '', final: true, atMs: 900 });
  assert.equal(draft.targetSegments.length, 1);
  assert.equal(draft.targetSegments[0].text, 'نص مؤقت');
  assert.equal(draft.targetSegments[0].endMs, 900);
});

test('finalizeDraft flushes pending text and computes duration', () => {
  const draft = createDraft({ startedAt: 1000 });
  appendCaption(draft, { channel: 'source', text: 'Still interim', atMs: 3000 });
  finalizeDraft(draft, { endedAt: 61000 });
  assert.equal(draft.sourceSegments.length, 1);
  assert.equal(draft.durationMs, 60000);
  assert.equal(draft.endedAt, 61000);
  assert.deepEqual(draft._pending, { source: null, target: null });
});

test('reconnect duplicate of the last finalized segment is dropped', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'Repeated turn.', atMs: 100 });
  assert.equal(draft.sourceSegments.length, 1);
  // Simulate resumption re-emitting the same finalized turn.
  appendCaption(draft, { channel: 'source', text: 'Repeated turn.', atMs: 5000, final: true });
  assert.equal(draft.sourceSegments.length, 1);
  appendCaption(draft, { channel: 'source', text: 'New turn.', atMs: 6000 });
  assert.equal(draft.sourceSegments.length, 2);
});

test('snapshotDraft saves a finalized copy while the live draft continues', () => {
  const draft = createDraft({ startedAt: 1000 });
  appendCaption(draft, { channel: 'source', text: 'Saved.', atMs: 2000 });
  const snapshot = snapshotDraft(draft, { endedAt: 5000 });
  assert.equal(snapshot.sourceSegments.length, 1);
  assert.equal(snapshot.durationMs, 4000);
  appendCaption(draft, { channel: 'source', text: 'More.', atMs: 8000 });
  assert.equal(snapshot.sourceSegments.length, 1);
  assert.equal(draft.sourceSegments.length, 2);
});

test('bookmarks validate input, bound notes, and stay time-ordered', () => {
  const draft = createDraft({ startedAt: 0 });
  assert.equal(validateBookmarkInput({ atMs: -5 }), null);
  assert.equal(validateBookmarkInput({ atMs: 'abc' }), null);
  assert.equal(validateBookmarkInput({ atMs: 25 * 60 * 60 * 1000 }), null);
  addBookmark(draft, { atMs: 9000, note: 'لحظة مهمة' });
  addBookmark(draft, { atMs: 2000, note: '' });
  assert.deepEqual(draft.bookmarks.map((b) => b.atMs), [2000, 9000]);
  assert.equal(draft.bookmarks[0].note, '');
  removeBookmark(draft, draft.bookmarks[0].id);
  assert.equal(draft.bookmarks.length, 1);
});

test('bookmark count is bounded', () => {
  const draft = createDraft({ startedAt: 0 });
  for (let index = 0; index < PLUS_LIMITS.MAX_BOOKMARKS_PER_SESSION + 25; index += 1) {
    addBookmark(draft, { atMs: index * 1000 });
  }
  assert.equal(draft.bookmarks.length, PLUS_LIMITS.MAX_BOOKMARKS_PER_SESSION);
});

test('text sanitization strips control characters and collapses whitespace', () => {
  assert.equal(sanitizeText('  a\u0000b\u0007   c  ', 100), 'ab c');
  assert.equal(sanitizeText('x'.repeat(50), 10), 'xxxxxxxxxx');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('https://example.com/watch?a=b'), 'https://example.com/watch?a=b');
  assert.equal(sanitizeUrl('https://user:pass@example.com/p#frag'), 'https://example.com/p');
  assert.equal(sanitizeOrigin('https://www.YouTube.com/watch?v=x'), 'www.youtube.com');
  assert.equal(sanitizeOrigin('https://example.com:8080/path'), 'example.com:8080');
  assert.equal(sanitizeOrigin('EXAMPLE.com:8080'), 'example.com:8080');
  assert.equal(sanitizeOrigin('not a host'), '');
  assert.equal(sanitizeOrigin('javascript:alert(1)'), '');
  assert.equal(sanitizeOrigin('ftp://example.com/'), '');
});

test('multiline note sanitizer preserves line breaks but bounds content', () => {
  assert.equal(sanitizeMultilineText('  سطر أول  \n  سطر  الثاني  \n\n\n\n  ثالث '), 'سطر أول\nسطر الثاني\n\nثالث');
  assert.equal(sanitizeMultilineText('a\u0000b\nc\u0007d', 100), 'ab\ncd');
  assert.equal(sanitizeMultilineText('x\n'.repeat(50).trim(), 5), 'x\nx\nx');
  // Omitting maxLength keeps the full note rather than truncating to nothing.
  const long = 'سطر\n'.repeat(500).trim();
  assert.equal(sanitizeMultilineText(long).length, long.length);
});

test('segment text and per-channel counts are bounded', () => {
  const draft = createDraft({ startedAt: 0 });
  const long = 'k'.repeat(PLUS_LIMITS.MAX_SEGMENT_TEXT + 500);
  appendCaption(draft, { channel: 'source', text: long, atMs: 1, final: true });
  assert.equal(draft.sourceSegments[0].text.length, PLUS_LIMITS.MAX_SEGMENT_TEXT);
  const many = createDraft({ startedAt: 0 });
  for (let index = 0; index < PLUS_LIMITS.MAX_SEGMENTS_PER_CHANNEL + 40; index += 1) {
    appendCaption(many, { channel: 'source', text: `Line ${index}.`, atMs: index * 10, final: true });
  }
  assert.equal(many.sourceSegments.length, PLUS_LIMITS.MAX_SEGMENTS_PER_CHANNEL);
});

test('notes and session identity are sanitized and bounded', () => {
  const draft = createDraft({ startedAt: 0 });
  setNotes(draft, ' ملاحظة  \u000B مهمة ');
  assert.equal(draft.notes, 'ملاحظة مهمة');
  setNotes(draft, 'n'.repeat(PLUS_LIMITS.MAX_NOTE_LENGTH + 10));
  assert.equal(draft.notes.length, PLUS_LIMITS.MAX_NOTE_LENGTH);
  setSessionIdentity(draft, { title: '  العنوان  ', pageUrl: 'https://youtube.com/watch?v=x', notes: '' });
  assert.equal(draft.title, 'العنوان');
  assert.equal(draft.pageUrl, 'https://youtube.com/watch?v=x');
  setSessionIdentity(draft, { pageUrl: 'ftp://bad' });
  assert.equal(draft.pageUrl, 'https://youtube.com/watch?v=x');
});

test('validateSessionRecord accepts clean records and rejects malformed ones', () => {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  appendCaption(draft, { channel: 'target', text: 'مرحبا.', atMs: 100, turnId: 12 });
  finalizeDraft(draft, { endedAt: 5000 });
  setSessionIdentity(draft, { title: 'جلسة', pageUrl: 'https://youtube.com/watch?v=ok' });
  const clean = validateSessionRecord(draft);
  assert.ok(clean);
  assert.equal(clean.targetSegments.length, 1);
  assert.equal(clean.targetSegments[0].turnId, 12);
  assert.equal(clean.pageUrl, 'https://youtube.com/watch?v=ok');

  assert.equal(validateSessionRecord(null), null);
  assert.equal(validateSessionRecord({}), null);
  assert.equal(validateSessionRecord({ ...draft, schemaVersion: 99 }), null);
  assert.equal(validateSessionRecord({ ...draft, id: 'evil<script>' }), null);
  const noSegments = { ...draft, sourceSegments: 'nope', targetSegments: 7 };
  assert.deepEqual(validateSessionRecord(noSegments).sourceSegments, []);
  const invalidTurn = structuredClone(draft);
  invalidTurn.targetSegments[0].turnId = 'not-a-turn';
  assert.equal(validateSessionRecord(invalidTurn).targetSegments[0].turnId, null);
});

test('validateSessionRecord strips unexpected bookmark and volume values', () => {
  const base = validateSessionRecord({
    schemaVersion: 1,
    id: 'plussession_test123',
    createdAt: 5,
    sourceSegments: [],
    targetSegments: [],
    bookmarks: [{ atMs: 1000, note: 'ok', id: 'b1', createdAt: 1 }, { atMs: -3 }, 'junk'],
    originalVolume: 9,
    dubbedVolume: 0.5
  });
  assert.equal(base.bookmarks.length, 1);
  assert.equal(base.originalVolume, null);
  assert.equal(base.dubbedVolume, 0.5);
});

test('transcriptLineCount sums both channels', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'a.', atMs: 1 });
  appendCaption(draft, { channel: 'source', text: 'b.', atMs: 2 });
  appendCaption(draft, { channel: 'target', text: 'ج.', atMs: 3 });
  assert.equal(transcriptLineCount(draft), 3);
  assert.equal(transcriptLineCount(null), 0);
});

test('unsaved drafts keep at most the three most recent', () => {
  const drafts = [1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, updatedAt: n }));
  assert.deepEqual(trimDrafts(drafts).map((d) => d.id), ['d5', 'd4', 'd3']);
  assert.deepEqual(trimDrafts([drafts[0]], 3).map((d) => d.id), ['d1']);
  assert.deepEqual(trimDrafts(null), []);
});

test('saved sessions are trimmed to the newest when over the cap', () => {
  const sessions = Array.from({ length: PLUS_LIMITS.MAX_SAVED_SESSIONS + 5 }, (_, index) => ({
    id: `s${index}`,
    updatedAt: index
  }));
  const trimmed = trimSavedSessions(sessions);
  assert.equal(trimmed.length, PLUS_LIMITS.MAX_SAVED_SESSIONS);
  assert.equal(trimmed[0].id, `s${PLUS_LIMITS.MAX_SAVED_SESSIONS + 4}`);
});

test('total transcript characters are bounded to prevent runaway memory', () => {
  const draft = createDraft({ startedAt: 0 });
  const big = 'x'.repeat(100_000);
  let accepted = true;
  for (let index = 0; index < 60; index += 1) {
    const before = draft.sourceSegments.length;
    appendCaption(draft, { channel: 'source', text: `${big} ${index}.`, atMs: index * 10, final: true });
    if (draft.sourceSegments.length === before && index > 5) {
      accepted = false;
      break;
    }
  }
  assert.equal(accepted, false);
});
