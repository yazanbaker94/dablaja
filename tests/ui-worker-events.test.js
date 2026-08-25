import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(file, 'utf8');

test('all open extension surfaces react to entitlement changes', async () => {
  const [popup, library, sidepanel, stats] = await Promise.all([
    read('src/popup/popup.js'),
    read('src/library/library.js'),
    read('src/sidepanel/sidepanel.js'),
    read('src/stats/stats.js')
  ]);

  for (const [name, source] of Object.entries({ popup, library, sidepanel, stats })) {
    assert.ok(source.includes('PLUS_LICENSE_ACTIVATED'), `${name} must react to activation`);
    assert.ok(source.includes('PLUS_LICENSE_REVOKED'), `${name} must react to revocation`);
  }
});

test('purchase failures are surfaced wherever an upgrade can remain open', async () => {
  const [popup, library, stats] = await Promise.all([
    read('src/popup/popup.js'),
    read('src/library/library.js'),
    read('src/stats/stats.js')
  ]);
  for (const [name, source] of Object.entries({ popup, library, stats })) {
    assert.ok(source.includes('PLUS_POLL_TIMEOUT'), `${name} must surface checkout timeout`);
    assert.ok(source.includes('PLUS_POLL_FAILED'), `${name} must surface checkout failure`);
  }
});

test('draft storage warnings reach the popup, library, and side panel', async () => {
  const [popup, library, sidepanel] = await Promise.all([
    read('src/popup/popup.js'),
    read('src/library/library.js'),
    read('src/sidepanel/sidepanel.js')
  ]);
  for (const [name, source] of Object.entries({ popup, library, sidepanel })) {
    assert.ok(source.includes('PLUS_STORAGE_WARNING'), `${name} must surface draft storage warnings`);
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
