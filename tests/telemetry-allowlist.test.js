import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../src/shared/constants.js';
import { reportRemoteError } from '../src/shared/telemetry.js';

test('telemetry outgoing payload strictly adheres to allowlist and drops all freeform error_message/stacks/keys', async (t) => {
  const capturedFetches = [];
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;

  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.0.0' })
    },
    storage: {
      local: {
        store: new Map([
          [STORAGE_KEYS.INSTALL_ID, 'a'.repeat(32)],
          [STORAGE_KEYS.PLUS_INSTALL_CREDENTIAL, 'b'.repeat(64)]
        ]),
        get: async (key) => {
          const map = globalThis.chrome.storage.local.store;
          if (key === STORAGE_KEYS.ANALYTICS_CONSENT) {
            return { [STORAGE_KEYS.ANALYTICS_CONSENT]: true };
          }
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) {
            if (map.has(k)) out[k] = map.get(k);
          }
          return out;
        },
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) globalThis.chrome.storage.local.store.set(k, v);
        }
      }
    }
  };

  globalThis.fetch = async (url, options) => {
    capturedFetches.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'ok' })
    };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  });

  const fakeSyntheticAiza = 'AIza' + '9'.repeat(35);
  const fakeSyntheticAq = 'AQ.' + '8'.repeat(35);
  const fakeUrl = 'https://secret.example.com/stream?key=xyz';
  const fakeTranscript = 'Secret sensitive conversation text in Arabic or English';
  const fakeStack = 'Error: boom\n    at WebSocket.connect (chrome-extension://abc/sw.js:12:34)';

  const payload = {
    code: 'network_error',
    message: `Connection to ${fakeUrl} failed with key ${fakeSyntheticAiza} and auth ${fakeSyntheticAq}`,
    stack: fakeStack,
    transcript: fakeTranscript,
    title: 'Secret Meeting Video Title',
    url: fakeUrl,
    status: 'error',
    site: 'https://www.youtube.com/watch?v=12345',
    reconnectCount: 3,
    extra_field_evil: 'should_be_dropped'
  };

  await reportRemoteError(payload);

  assert.equal(capturedFetches.length, 1, 'Should have sent exactly 1 telemetry report');
  const req = capturedFetches[0];
  const body = req.body;

  // 1. Assert only allowlisted keys exist
  const allowedKeys = new Set([
    'event_id',
    'error_code',
    'status',
    'site_host',
    'extension_version',
    'reconnect_count'
  ]);

  for (const key of Object.keys(body)) {
    assert.ok(allowedKeys.has(key), `Disallowed key found in telemetry request body: ${key}`);
  }

  // 2. Assert raw error_message and forbidden strings are absent from serialized body
  const rawBodyStr = JSON.stringify(body);
  assert.ok(!('error_message' in body), 'error_message must not be sent');
  assert.ok(!('message' in body), 'message must not be sent');
  assert.ok(!('stack' in body), 'stack trace must not be sent');
  assert.ok(!('transcript' in body), 'transcript must not be sent');
  assert.ok(!('title' in body), 'page title must not be sent');
  assert.ok(!('url' in body), 'raw URL must not be sent');
  assert.ok(!('extra_field_evil' in body), 'unknown fields must be dropped');

  assert.ok(!rawBodyStr.includes(fakeSyntheticAiza), 'Synthetic AIza key must not appear anywhere in body');
  assert.ok(!rawBodyStr.includes(fakeSyntheticAq), 'Synthetic AQ key must not appear anywhere in body');
  assert.ok(!rawBodyStr.includes(fakeUrl), 'URL must not appear anywhere in body');
  assert.ok(!rawBodyStr.includes(fakeTranscript), 'Transcript text must not appear anywhere in body');
  assert.ok(!rawBodyStr.includes('boom'), 'Stack trace text must not appear anywhere in body');

  // 3. Verify allowlisted values are correctly preserved and bounded
  assert.equal(body.error_code, 'network_error');
  assert.equal(body.status, 'error');
  assert.equal(body.site_host, 'youtube');
  assert.equal(body.reconnect_count, 3);
  assert.equal(body.extension_version, '1.0.0');
  assert.ok(typeof body.event_id === 'string' && body.event_id.length >= 16);
  assert.equal('install_id' in body, false, 'optional diagnostics must not carry the stable licensing installation identity');
});

test('diagnostic reporting surfaces a rejected server write as false', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: async () => ({ [STORAGE_KEYS.ANALYTICS_CONSENT]: true }) } }
  };
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  t.after(() => { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; });
  const result = await reportRemoteError({ code: 'rate_limited', status: 'rate_limited', site: 'other' });
  assert.equal(result, false);
});
