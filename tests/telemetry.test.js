import test from 'node:test';
import assert from 'node:assert/strict';
import { platformCategory, reportUsageSession, usageEventPayload } from '../src/shared/telemetry.js';

test('platformCategory exposes only a coarse supported category', () => {
  assert.equal(platformCategory('https://www.youtube.com/watch?v=secret'), 'youtube');
  assert.equal(platformCategory('https://youtu.be/abc'), 'youtube');
  assert.equal(platformCategory('https://x.com/private/status/1'), 'x');
  assert.equal(platformCategory('https://player.twitch.tv/?channel=one'), 'twitch');
  assert.equal(platformCategory('https://courses.example.test/private/lesson'), 'other');
});

test('usage payload contains no URL, title, transcript, key, or persistent identifier', () => {
  const payload = usageEventPayload({
    site: 'https://www.youtube.com/watch?v=private-id',
    dubbedMs: 12_345.4,
    eventId: 'test-event-1234567890'
  });
  assert.deepEqual(payload, {
    event_id: 'test-event-1234567890',
    platform: 'youtube',
    dubbed_ms: 12_345
  });
  assert.deepEqual(Object.keys(payload).sort(), ['dubbed_ms', 'event_id', 'platform']);
});

test('usage payload rejects trivial sessions and bounds duration', () => {
  assert.equal(usageEventPayload({ dubbedMs: 4_999, eventId: 'short-event-123456' }), null);
  assert.equal(
    usageEventPayload({ dubbedMs: Number.MAX_SAFE_INTEGER, eventId: 'long-event-1234567' }).dubbed_ms,
    8 * 60 * 60 * 1000
  );
});

test('remote usage reporting is disabled until the user opts in', async (t) => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.chrome = { storage: { local: { get: async () => ({ anonymousUsageConsent: false }) } } };
  globalThis.fetch = async () => { calls += 1; return { ok: true }; };
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  assert.equal(await reportUsageSession({ site: 'https://youtube.com/watch?v=x', dubbedMs: 20_000 }), false);
  assert.equal(calls, 0);
});

test('opted-in usage reporting sends only the three approved fields', async (t) => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let sent;
  globalThis.chrome = { storage: { local: { get: async () => ({ anonymousUsageConsent: true }) } } };
  globalThis.fetch = async (_url, options) => { sent = JSON.parse(options.body); return { ok: true }; };
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  assert.equal(await reportUsageSession({ site: 'https://twitch.tv/private', dubbedMs: 20_000 }), true);
  assert.deepEqual(Object.keys(sent).sort(), ['dubbed_ms', 'event_id', 'platform']);
  assert.equal(sent.platform, 'twitch');
  assert.equal(sent.dubbed_ms, 20_000);
});
