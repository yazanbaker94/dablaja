import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanup = path.join(root, 'scripts', 'cleanup-dablaja-e2e.py');

function python(code, ...args) {
  return execFileSync('python', ['-c', code, ...args], { encoding: 'utf8' }).trim();
}

test('live-E2E cleanup requires and verifies a backup before exact synthetic-row removal', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dablaja-e2e-cleanup-'));
  const db = path.join(temp, 'source.db');
  const backup = path.join(temp, 'backup.db');
  try {
    python(`
import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
c.executescript("""
CREATE TABLE usage_event_ids(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE error_reports(event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE usage_daily(day TEXT NOT NULL, platform TEXT NOT NULL, dubbed_ms INTEGER NOT NULL, sessions INTEGER NOT NULL, PRIMARY KEY(day, platform));
""")
c.executemany("INSERT INTO usage_event_ids VALUES (?, ?)", [('real-event','2026-08-25T10:00:00Z'),('e2eusage-test','2026-08-25T11:00:00Z')])
c.executemany("INSERT INTO error_reports VALUES (?, ?)", [('real-error','2026-08-25T10:00:00Z'),('e2e-error-test','2026-08-25T11:00:00Z')])
c.execute("INSERT INTO usage_daily VALUES ('2026-08-25','youtube',180000,3)")
c.commit()
`, db);

    const dry = execFileSync('python', [cleanup, db], { encoding: 'utf8' });
    assert.match(dry, /synthetic_usage_events=1/);
    assert.match(dry, /synthetic_error_events=1/);
    assert.match(dry, /mode=dry-run/);

    const refused = spawnSync('python', [cleanup, db, '--apply'], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /--apply requires --backup/);

    const applied = execFileSync('python', [cleanup, db, '--apply', '--backup', backup], { encoding: 'utf8' });
    assert.match(applied, /cleanup=PASS/);
    const live = python("import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('select count(*) from usage_event_ids').fetchone()[0],c.execute('select count(*) from error_reports').fetchone()[0],*c.execute(\"select dubbed_ms,sessions from usage_daily where day='2026-08-25' and platform='youtube'\").fetchone()]))", db);
    assert.equal(live, '[1, 1, 120000, 2]');
    const saved = python("import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('select count(*) from usage_event_ids').fetchone()[0],c.execute('select count(*) from error_reports').fetchone()[0],*c.execute(\"select dubbed_ms,sessions from usage_daily where day='2026-08-25' and platform='youtube'\").fetchone()]))", backup);
    assert.equal(saved, '[2, 2, 180000, 3]');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
