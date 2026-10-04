import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_KIND,
  MAX_BACKUP_BYTES,
  createBackup,
  mergeSessions,
  parseBackup
} from '../src/shared/library-backup.js';
import { LIBRARY_LIMITS, createDraft, appendCaption, finalizeDraft } from '../src/shared/library-session.js';

function makeSession(id, updatedAt = 1000, text = 'نص الجلسة.') {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'youtube.com' });
  appendCaption(draft, { channel: 'target', text, atMs: 500, final: true });
  finalizeDraft(draft, { endedAt: 2000 });
  return { ...draft, id, updatedAt };
}

test('createBackup wraps validated sessions in a versioned envelope', () => {
  const json = createBackup([makeSession('plussession_a1'), null, { junk: true }]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'dablaja');
  assert.equal(parsed.kind, BACKUP_KIND);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.sessionCount, 1);
  assert.equal(parsed.sessions[0].id, 'plussession_a1');
  assert.ok(!JSON.stringify(parsed).includes('apiKey'));
});

test('parseBackup round-trips a created backup', () => {
  const result = parseBackup(createBackup([makeSession('plussession_a1'), makeSession('plussession_b2')]));
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.rejected, 0);
});

test('parseBackup rejects empty, non-JSON and oversized inputs', () => {
  assert.equal(parseBackup('').ok, false);
  assert.equal(parseBackup('not json at all').ok, false);
  assert.equal(parseBackup('x'.repeat(MAX_BACKUP_BYTES + 10)).ok, false);
});

test('parseBackup rejects wrong envelopes and schema versions', () => {
  assert.equal(parseBackup('{"app":"other","kind":"x"}').ok, false);
  assert.equal(parseBackup(JSON.stringify({ app: 'dablaja', kind: BACKUP_KIND, schemaVersion: 1 })).ok, false);
  assert.equal(parseBackup(JSON.stringify({ app: 'dablaja', kind: BACKUP_KIND, schemaVersion: 9, sessions: [] })).ok, false);
  assert.equal(parseBackup(JSON.stringify({ app: 'dablaja', kind: BACKUP_KIND, schemaVersion: 1, sessions: 'nope' })).ok, false);
});

test('parseBackup drops malformed sessions but keeps valid ones', () => {
  const backup = JSON.stringify({
    app: 'dablaja',
    kind: BACKUP_KIND,
    schemaVersion: 1,
    sessions: [makeSession('plussession_a1'), { broken: true }, 42]
  });
  const result = parseBackup(backup);
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.rejected, 2);
});

test('parseBackup fails when every session is malformed', () => {
  const backup = JSON.stringify({
    app: 'dablaja',
    kind: BACKUP_KIND,
    schemaVersion: 1,
    sessions: [{ broken: true }]
  });
  assert.equal(parseBackup(backup).ok, false);
});

test('mergeSessions keeps existing data and dedupes by newest updatedAt', () => {
  const existing = [makeSession('plussession_a1', 5000)];
  const imported = [
    makeSession('plussession_a1', 9000),
    makeSession('plussession_b2', 100)
  ];
  const merged = mergeSessions(existing, imported);
  assert.equal(merged.sessions.length, 2);
  assert.equal(merged.updated, 1);
  assert.equal(merged.added, 1);
  assert.equal(merged.sessions.find((s) => s.id === 'plussession_a1').updatedAt, 9000);
});

test('mergeSessions never replaces with an older record', () => {
  const existing = [makeSession('plussession_a1', 9000)];
  const merged = mergeSessions(existing, [makeSession('plussession_a1', 1000)]);
  assert.equal(merged.updated, 0);
  assert.equal(merged.sessions[0].updatedAt, 9000);
});

test('mergeSessions ignores malformed imports and never removes existing data', () => {
  const existing = Array.from({ length: LIBRARY_LIMITS.MAX_SAVED_SESSIONS }, (_, i) =>
    makeSession(`plussession_e${i}`, 1000 + i)
  );
  const imported = [{ broken: true }, makeSession('plussession_new1', 50)];
  // Merging no longer capacity-trims: the atomic database layer owns capacity
  // decisions so rejections are reported instead of silently dropped.
  const merged = mergeSessions(existing, imported);
  assert.equal(merged.added, 1);
  assert.equal(merged.sessions.length, LIBRARY_LIMITS.MAX_SAVED_SESSIONS + 1);
  assert.ok(merged.sessions.some((session) => session.id === 'plussession_new1'));
  // Every pre-existing record survives untouched.
  for (const session of existing) {
    assert.ok(merged.sessions.includes(session), session.id);
  }
});

test('mergeSessions dedupes imported duplicates deterministically', () => {
  const existing = [makeSession('plussession_a1', 500)];
  const imported = [
    makeSession('plussession_b2', 300),
    makeSession('plussession_b2', 900), // superseded duplicate
    makeSession('plussession_a1', 100)  // older than existing — ignored
  ];
  const merged = mergeSessions(existing, imported);
  assert.equal(merged.superseded, 1);
  assert.equal(merged.added, 1);
  assert.equal(merged.updated, 0);
  assert.equal(merged.sessions.length, 2);
});

test('backup size ceiling is sane', () => {
  assert.ok(MAX_BACKUP_BYTES >= 1024 * 1024);
});
