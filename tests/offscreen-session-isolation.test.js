import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'src/offscreen/offscreen.js'), 'utf8');

test('cleanup cancels the one-shot setup retry and closes both worklet ports', () => {
  const cleanup = source.slice(source.indexOf('async function cleanup'), source.indexOf('async function fatal'));
  assert.match(cleanup, /clearTimeout\(current\.setupRetryTimer\)/);
  assert.match(cleanup, /current\.captureNode\.port\.onmessage = null/);
  assert.match(cleanup, /current\.playbackNode\.port\.onmessage = null/);
  assert.match(cleanup, /current\.captureNode\?\.port\.close\(\)/);
  assert.match(cleanup, /current\.playbackNode\?\.port\.close\(\)/);
});

test('reconnect and setup-fallback timers are bound to their owning session', () => {
  assert.match(source, /session !== reconnectOwner \|\| reconnectOwner\.stopping/g);
  assert.match(source, /session !== retryOwner \|\| retryOwner\.stopping/);
  assert.match(source, /setupRetryTimer: null/);
});

test('queued socket, worklet, and track events reject a replacement session', () => {
  assert.match(source, /const socketOwner = session/);
  assert.match(source, /await event\.data\.text\(\);\s*if \(session !== socketOwner \|\| socketOwner\.stopping \|\| socketOwner\.socket !== socket\) return/);
  assert.match(source, /socket\.onerror = \(\) => \{\s*if \(session !== socketOwner \|\| socketOwner\.stopping \|\| socketOwner\.socket !== socket\) return/);
  assert.match(source, /socket\.onclose = \(event\) => \{\s*if \(session !== socketOwner \|\| socketOwner\.stopping \|\| socketOwner\.socket !== socket\) return;\s*clearTimeout\(socketOwner\.errorWatchdog\)/);
  assert.match(source, /session !== callbackOwner \|\| callbackOwner\.stopping/g);
  assert.match(source, /session === callbackOwner && !callbackOwner\.stopping/);
});
