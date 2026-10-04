import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSrtTimestamps,
  msToSrtTime,
  toBilingualRows,
  toExportJson,
  toPlainText,
  toPrintRows,
  toSrt
} from '../src/shared/library-export.js';
import { createDraft, addBookmark, appendCaption, finalizeDraft, setNotes, setSessionIdentity } from '../src/shared/library-session.js';

function buildBilingualSession() {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  appendCaption(draft, { channel: 'source', text: 'Hello world', atMs: 1000 });
  appendCaption(draft, { channel: 'source', text: 'Hello world.', atMs: 2600, final: true });
  appendCaption(draft, { channel: 'target', text: 'مرحباً بالعالم', atMs: 1100 });
  appendCaption(draft, { channel: 'target', text: 'مرحباً بالعالم.', atMs: 2700, final: true });
  appendCaption(draft, { channel: 'source', text: 'Second line.', atMs: 4000, final: true });
  appendCaption(draft, { channel: 'target', text: 'السطر الثاني.', atMs: 4200, final: true });
  finalizeDraft(draft, { endedAt: 9000 });
  setSessionIdentity(draft, { title: 'جلسة اختبار', pageUrl: 'https://youtube.com/watch?v=x' });
  setNotes(draft, 'ملاحظة عامة');
  addBookmark(draft, { atMs: 5000, note: 'لحظة مهمة' });
  return draft;
}

test('plain text export includes title, notes, bookmarks and bilingual lines', () => {
  const text = toPlainText(buildBilingualSession());
  assert.match(text, /جلسة اختبار/);
  assert.match(text, /ملاحظة عامة/);
  assert.match(text, /\[00:05\] لحظة مهمة/);
  assert.match(text, /EN: Hello world\./);
  assert.match(text, /AR: مرحباً بالعالم\./);
  assert.match(text, /المدة: 9 ثانية/);
});

test('plain text export handles empty sessions', () => {
  const draft = finalizeDraft(createDraft({ startedAt: 0 }), { endedAt: 100 });
  assert.match(toPlainText(draft), /لا توجد نصوص محفوظة/);
  assert.equal(toPlainText(null), '');
});

test('SRT timestamps format correctly', () => {
  assert.equal(msToSrtTime(0), '00:00:00,000');
  assert.equal(msToSrtTime(3661500), '01:01:01,500');
  assert.equal(msToSrtTime(-50), '00:00:00,000');
});

test('bilingual SRT pairs overlapping English under Arabic cues', () => {
  const srt = toSrt(buildBilingualSession());
  const blocks = srt.split('\n\n');
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^1\n00:00:01,100 --> 00:00:02,700\nمرحباً بالعالم\.\nHello world\.$/);
  assert.match(blocks[1], /^2\n00:00:04,200 --> 00:00:05,000\nالسطر الثاني\.\nSecond line\.$/);
});

test('SRT extends zero-length cues so single-shot finals stay readable', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'target', text: 'نص.', atMs: 0, final: true });
  finalizeDraft(draft, { endedAt: 10 });
  assert.equal(hasSrtTimestamps(draft), true);
  assert.match(toSrt(draft), /00:00:00,000 --> 00:00:00,800\nنص\./);
});

test('JSON export carries the session payload and no key or audio fields', () => {
  const json = toExportJson(buildBilingualSession());
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'dablaja');
  assert.equal(parsed.kind, 'dablaja-plus-session');
  assert.equal(parsed.session.title, 'جلسة اختبار');
  assert.equal(parsed.session.targetSegments.length, 2);
  const serialized = JSON.stringify(parsed);
  for (const forbidden of ['apiKey', 'api_key', 'audio', 'pcm', 'base64']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), forbidden);
  }
  assert.equal(toExportJson(null), '');
});

test('JSON export never carries unknown or forbidden input fields', () => {
  const draft = buildBilingualSession();
  draft.nested = { apiKey: 'AIza-supersecret', audio: 'pcm-bytes' };
  const parsed = JSON.parse(toExportJson(draft));
  const serialized = JSON.stringify(parsed);
  for (const forbidden of ['apiKey', 'api_key', 'audio', 'pcm', 'base64', 'nested']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), forbidden);
  }
  assert.equal(parsed.session.targetSegments.length, 2);
});

test('print rows align bilingual columns with timestamps', () => {
  const rows = toPrintRows(buildBilingualSession());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'Hello world.');
  assert.equal(rows[0].target, 'مرحباً بالعالم.');
  assert.equal(rows[1].atMs, 4200);
});

test('turn-aware rows keep differently split English and Arabic in one box', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, {
    channel: 'source', text: 'A complete English thought.', atMs: 1000, final: true, turnId: 7
  });
  appendCaption(draft, {
    channel: 'target', text: 'فكرة إنجليزية', atMs: 5500, final: true, turnId: 7
  });
  appendCaption(draft, {
    channel: 'target', text: 'كاملة بالعربية.', atMs: 7200, final: true, turnId: 7
  });
  const rows = toBilingualRows(finalizeDraft(draft, { endedAt: 8000 }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'A complete English thought.');
  assert.equal(rows[0].target, 'فكرة إنجليزية كاملة بالعربية.');
  assert.equal(rows[0].missingSource, false);
  assert.equal(rows[0].missingTarget, false);
});

test('legacy rows group a denser translated stream by time instead of array index', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'First long source.', atMs: 1000, final: true });
  appendCaption(draft, { channel: 'source', text: 'Second source.', atMs: 10_000, final: true });
  appendCaption(draft, { channel: 'target', text: 'الجزء الأول.', atMs: 1200, final: true });
  appendCaption(draft, { channel: 'target', text: 'تكملة الجزء الأول.', atMs: 2200, final: true });
  appendCaption(draft, { channel: 'target', text: 'الجزء الثاني.', atMs: 10_200, final: true });
  const rows = toBilingualRows(finalizeDraft(draft, { endedAt: 11_000 }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'First long source.');
  assert.equal(rows[0].target, 'الجزء الأول. تكملة الجزء الأول.');
  assert.equal(rows[1].source, 'Second source.');
  assert.equal(rows[1].target, 'الجزء الثاني.');
});

test('genuinely missing counterparts are explicit instead of deceptively paired', () => {
  const draft = createDraft({ startedAt: 0 });
  appendCaption(draft, { channel: 'source', text: 'Untranslated source.', atMs: 1000, final: true });
  appendCaption(draft, { channel: 'target', text: 'ترجمة منفصلة.', atMs: 30_000, final: true });
  const rows = toBilingualRows(finalizeDraft(draft, { endedAt: 31_000 }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].missingTarget, true);
  assert.equal(rows[1].missingSource, true);
  const plain = toPlainText(draft);
  assert.match(plain, /لم تصل ترجمة عربية/);
  assert.match(plain, /لم يصل نص إنجليزي/);
});
