import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hostnameOf, normalizeOrigin } from '../src/shared/normalize-origin.js';
import { decidePut, planBatchInsert, SAVED_SESSION_LIMIT_MESSAGE } from '../src/shared/library-db.js';
import { LIBRARY_LIMITS, createDraft, sanitizeOrigin, sessionTitleOrDefault } from '../src/shared/library-session.js';
import { sessionSummary } from '../src/shared/library-search.js';

const root = path.resolve(import.meta.dirname, '..');

// ---- Origin normalization (shared by sessions and site profiles) ----------

test('normalizeOrigin accepts full HTTP(S) URLs, origins and bare hosts', () => {
  assert.equal(normalizeOrigin('https://www.YouTube.com/watch?v=x'), 'www.youtube.com');
  assert.equal(normalizeOrigin('https://example.com:8080/path'), 'example.com:8080');
  assert.equal(normalizeOrigin('http://EXAMPLE.com'), 'example.com');
  assert.equal(normalizeOrigin('example.com.'), 'example.com');
  assert.equal(normalizeOrigin('EXAMPLE.com:8443'), 'example.com:8443');
  assert.equal(hostnameOf('https://www.youtube.com/watch'), 'www.youtube.com');
  assert.equal(hostnameOf('example.com:8080'), 'example.com');
});

test('normalizeOrigin rejects credentials, non-HTTP protocols and junk', () => {
  // URLs carrying userinfo are rejected outright — never silently stripped.
  assert.equal(normalizeOrigin('https://user:pass@example.com/'), '');
  assert.equal(normalizeOrigin('http://alice@example.com/'), '');
  assert.equal(normalizeOrigin('ftp://example.com/'), '');
  assert.equal(normalizeOrigin('javascript:alert(1)'), '');
  assert.equal(normalizeOrigin('not a host'), '');
  assert.equal(normalizeOrigin(''), '');
  assert.equal(normalizeOrigin(null), '');
  assert.equal(normalizeOrigin('https://ok.com/#fragment'), 'ok.com');
  assert.equal(normalizeOrigin('example.com:8080'), 'example.com:8080');
  assert.equal(normalizeOrigin('example..com'), '');
  assert.equal(normalizeOrigin('-bad.example.com'), '');
  assert.equal(normalizeOrigin('bad.example.com-'), '');
  assert.equal(normalizeOrigin('example.com:99999'), '');
});

test('session records reuse the same normalization', () => {
  const draft = createDraft({ startedAt: 0, siteOrigin: 'https://courses.example.edu:8443/lesson' });
  assert.equal(draft.siteOrigin, 'courses.example.edu:8443');
  assert.equal(sanitizeOrigin('https://www.youtube.com'), 'www.youtube.com');
});

// ---- Title fallback ---------------------------------------------------------

test('title fallback: sanitized page title → hostname → جلسة دبلجة', () => {
  assert.equal(sessionTitleOrDefault('  عنوان  ', 'youtube.com'), 'عنوان');
  assert.equal(sessionTitleOrDefault('', 'www.youtube.com'), 'youtube.com');
  assert.equal(sessionTitleOrDefault(null, ''), 'جلسة دبلجة');
});

test('sessionSummary prefers a real hostname over a placeholder title', () => {
  const summary = sessionSummary({
    id: 'plussession_a1',
    title: 'جلسة دبلجة',
    siteOrigin: 'www.youtube.com',
    updatedAt: 1,
    sourceSegments: [],
    targetSegments: [],
    bookmarks: []
  });
  assert.equal(summary.title, 'youtube.com');
  assert.equal(sessionSummary({ id: 'x', title: '', siteOrigin: '', updatedAt: 1 }).title, 'جلسة بدون عنوان');
});

// ---- IndexedDB cap decisions (pure) ----------------------------------------

test('decidePut allows updates at the cap and rejects new records', () => {
  const limit = LIBRARY_LIMITS.MAX_SAVED_SESSIONS;
  assert.equal(decidePut({ exists: true, count: limit }).ok, true);
  const rejected = decidePut({ exists: false, count: limit });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, SAVED_SESSION_LIMIT_MESSAGE);
  assert.equal(decidePut({ exists: false, count: limit - 1 }).ok, true);
  assert.equal(decidePut({ exists: false, count: undefined }).ok, true);
});

test('no tier-based save limit: every tier saves up to the storage cap', () => {
  // The free-tier gate is the VIEW lock (oldest session unlocked), not a
  // save cap — decidePut treats every save identically.
  assert.equal(decidePut({ exists: false, count: 0 }).ok, true);
  assert.equal(decidePut({ exists: false, count: 1 }).ok, true);
  assert.equal(decidePut({ exists: false, count: 42 }).ok, true);
  // Only the shared 500-record storage cap rejects.
  const rejected = decidePut({ exists: false, count: LIBRARY_LIMITS.MAX_SAVED_SESSIONS });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'saved_session_limit');
});

test('planBatchInsert dedupes by id and admits deterministically within capacity', () => {
  const records = [
    { id: 'plussession_a' }, { id: 'plussession_a' }, { id: 'plussession_b' },
    { id: 'plussession_c' }, { id: 'plussession_d' }
  ];
  // count 499 with limit 500 leaves capacity for exactly one new id after
  // the existing 'plussession_a' update.
  const plan = planBatchInsert(records, ['plussession_a', 'plussession_z'], 499, 500);
  assert.deepEqual(plan.admitted.map((r) => r.id), ['plussession_a', 'plussession_b']);
  assert.deepEqual(plan.rejected.map((r) => r.id), ['plussession_c', 'plussession_d']);
  // No duplicates survive planning.
  const uniqueIds = new Set(plan.admitted.map((r) => r.id));
  assert.equal(uniqueIds.size, plan.admitted.length);
});

test('production library message wiring passes the settings adapter only', async () => {
  const worker = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  const handlerStart = worker.indexOf('const handleLibraryMessage = createLibraryMessageHandler({');
  const handlerEnd = worker.indexOf('\n});', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'library handler wiring exists');
  const wiring = worker.slice(handlerStart, handlerEnd);
  assert.match(wiring, /settings:\s*librarySettingsAdapter/);
  assert.doesNotMatch(wiring, /entitlement|InstallId/);
});

test('production caption pipeline preserves Gemini turn ids into library drafts', async () => {
  const [offscreen, worker] = await Promise.all([
    readFile(path.join(root, 'src/offscreen/offscreen.js'), 'utf8'),
    readFile(path.join(root, 'src/service-worker.js'), 'utf8')
  ]);
  assert.match(offscreen, /turnId:\s*session\.captionTurnId/);
  assert.match(offscreen, /session\.captionTurnId\s*\+=\s*1/);
  assert.match(worker, /turnId:\s*message\.turnId/);
});

test('library page restores both persisted toggles and active-site profiles are captured', async () => {
  const [library, worker] = await Promise.all([
    readFile(path.join(root, 'src/library/library.js'), 'utf8'),
    readFile(path.join(root, 'src/service-worker.js'), 'utf8')
  ]);
  const reloadStart = library.indexOf('async function reloadAll()');
  const reloadEnd = library.indexOf('\n}', reloadStart);
  const reloadBody = library.slice(reloadStart, reloadEnd);
  assert.doesNotMatch(library, /renderDraftCard|PLUS_SAVE_UNSAVED|PLUS_DISCARD_DRAFT/);
  assert.match(reloadBody, /await renderSettings\(\{ refreshStatus: false \}\)/);
  assert.ok(
    reloadBody.indexOf("send({ type: 'LIBRARY_GET_STATUS' })") < reloadBody.indexOf('renderList()'),
    'library settings must be restored before cards render'
  );
  const rememberStart = worker.indexOf('async setRemember(value)');
  const rememberEnd = worker.indexOf('\n  },', rememberStart);
  const rememberBody = worker.slice(rememberStart, rememberEnd);
  assert.match(rememberBody, /state\.tabOrigin && sessionVolumes/);
  assert.match(rememberBody, /originalVolume:\s*sessionVolumes\.original/);
  assert.match(rememberBody, /dubbedVolume:\s*sessionVolumes\.dubbed/);
});

// ---- Packaging gates -------------------------------------------------------

test('manifest and package versions stay in sync', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(packageJson.version, manifest.version);
});

test('manifest validation passes cleanly', () => {
  const output = execFileSync(process.execPath, ['scripts/validate-manifest.mjs'], {
    cwd: root,
    stdio: 'pipe'
  }).toString();
  assert.match(output, /Manifest valid/);
});
