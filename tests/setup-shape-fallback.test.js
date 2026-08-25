// Regression: the 1007 setup-shape fallback must actually flip shapes.
//
// gemini-3.5-live-translate-preview rejects transcription fields nested in
// generationConfig (WSS 1007 "Unknown name inputAudioTranscription at
// setup.generation_config") and accepts them at the setup root. The session
// therefore starts on the root shape, and a single 1007 flips to the nested
// shape once. connectSocket() must never reset that choice — resetting it
// made every session fail with "WSS 1007" no matter how valid the key was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetupMessage, buildLegacySetupMessage } from '../src/shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('session starts on the root transcription-field shape', async () => {
  const src = await readFile(path.join(root, 'src/offscreen/offscreen.js'), 'utf8');
  assert.match(src, /setupPrimary: false,\s*\n\s*setupRetryUsed: false/, 'session literal must init root-shape first');
});

test('connectSocket never resets the setup-shape selector', async () => {
  const src = await readFile(path.join(root, 'src/offscreen/offscreen.js'), 'utf8');
  const start = src.indexOf('function connectSocket()');
  const body = src.slice(start, src.indexOf('socket.onopen = () =>', start));
  assert.ok(!/^\s*session\.setupPrimary = true;\s*$/m.test(body), 'connectSocket must not force the nested shape back on');
  // Null-safe lazy init is allowed; hard assignment is not.
  assert.match(body, /if \(session\.setupPrimary == null\)/);
});

test('1007 fallback flips the shape exactly once, in either direction', async () => {
  const src = await readFile(path.join(root, 'src/offscreen/offscreen.js'), 'utf8');
  const idx = src.indexOf("event.code === 1007");
  const block = src.slice(idx, src.indexOf('return;', idx));
  assert.match(block, /setupRetryUsed = true/, 'retry budget must be consumed');
  assert.match(block, /session\.setupPrimary = !session\.setupPrimary/, 'shape must flip');
});

test('both wire shapes remain available and structurally distinct', () => {
  const primary = JSON.stringify(buildSetupMessage());
  const legacy = JSON.stringify(buildLegacySetupMessage());
  assert.ok(primary.includes('"generationConfig":{"responseModalities":["AUDIO"],"translationConfig"'), 'nested shape keeps translationConfig in generationConfig');
  assert.ok(primary.includes('"inputAudioTranscription":{},"outputAudioTranscription":{}') && primary.indexOf('"inputAudioTranscription"') > primary.indexOf('"generationConfig"'), 'nested puts transcriptions inside generationConfig');
  const legacyParsed = JSON.parse(legacy).setup;
  assert.ok('inputAudioTranscription' in legacyParsed && !('inputAudioTranscription' in legacyParsed.generationConfig), 'legacy shape puts transcriptions at setup root');
});
