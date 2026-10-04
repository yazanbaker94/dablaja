import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');

test('session startup is single-flight and waits for an in-flight stop', () => {
  assert.match(source, /let startingPromise = null/);
  assert.match(source, /async function performStartSession/);
  const start = source.slice(
    source.indexOf('async function startSession(options'),
    source.indexOf('async function performStopSession')
  );
  assert.match(start, /if \(stoppingPromise\) await stoppingPromise/);
  assert.match(start, /if \(!startingPromise\)/);
  assert.match(start, /startingPromise = performStartSession\(options\)\.finally/);
  assert.match(start, /return startingPromise/);
});

test('stop waits for startup before disposing the resulting resources', () => {
  const stop = source.slice(
    source.indexOf('async function stopSession('),
    source.indexOf('async function setVolume')
  );
  assert.match(stop, /if \(startingPromise\) await startingPromise\.catch/);
  assert.match(stop, /if \(!stoppingPromise\)/);
});

test('normal start and diagnostics retry share the same failure cleanup', () => {
  assert.match(
    source,
    /\['START_SESSION', 'START_SESSION_FOR_LAST_TAB'\]\.includes\(message\?\.type\)/
  );
  assert.match(source, /const failedStartState = state/);
  assert.match(source, /recordEnd\(failedStartState, true\)/);
});

test('a duplicate start cannot tear down an already healthy session', () => {
  assert.match(source, /error\.code = 'session_already_active'/);
  assert.match(
    source,
    /\['START_SESSION', 'START_SESSION_FOR_LAST_TAB'\]\.includes\(message\?\.type\)\s*&& error\?\.code !== 'session_already_active'/
  );
});

test('a delayed capture stop event rechecks the current tab capture before cleanup', () => {
  const listener = source.slice(
    source.indexOf('chrome.tabCapture.onStatusChanged.addListener'),
    source.indexOf('chrome.runtime.onInstalled.addListener')
  );
  assert.match(listener, /await chrome\.tabCapture\.getCapturedTabs\(\)/);
  assert.match(listener, /captures\.find\(\(capture\) => capture\.tabId === info\.tabId\)/);
  assert.match(listener, /current && !\['stopped', 'error'\]\.includes\(current\.status\)/);
  assert.match(listener, /catch \{[\s\S]*?return;[\s\S]*?\}/);
});
