import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(file, 'utf8');

test('recovery storage warnings reach the popup and library', async () => {
  const [popup, library] = await Promise.all([
    read('src/popup/popup.js'),
    read('src/library/library.js')
  ]);
  for (const [name, source] of Object.entries({ popup, library })) {
    assert.ok(source.includes('LIBRARY_STORAGE_WARNING'), `${name} must surface recovery storage warnings`);
  }
});

test('library uses one consolidated runtime message listener', async () => {
  const library = await read('src/library/library.js');
  assert.equal(
    (library.match(/chrome\.runtime\.onMessage\.addListener/g) || []).length,
    1,
    'library must not accumulate duplicate runtime listeners'
  );
});

test('library listener handles only live worker broadcasts', async () => {
  const library = await read('src/library/library.js');
  assert.ok(library.includes("case 'LIBRARY_DRAFT_CHANGED'"), 'library must refresh on draft changes');
  assert.ok(library.includes("case 'LIBRARY_STORAGE_WARNING'"), 'library must surface storage warnings');
  for (const removed of ['PLUS_LICENSE_ACTIVATED', 'PLUS_LICENSE_REVOKED', 'PLUS_POLL_TIMEOUT', 'PLUS_POLL_FAILED']) {
    assert.ok(!library.includes(removed), `library must not handle removed broadcast ${removed}`);
  }
});
