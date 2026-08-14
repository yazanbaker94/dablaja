import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_USAGE_STATS,
  averageLatency,
  dayKey,
  niceScale,
  normalizeUsageStats,
  recordSessionEnd,
  recordSessionStart,
  sessionsInRange,
  siteKey,
  sitesInRange,
  topSites,
  weekComparison
} from '../src/shared/usage-stats.js';

test('usage stats keep only safe aggregate fields', () => {
  const normalized = normalizeUsageStats({
    totalDurationMs: 1000,
    activeDays: ['2026-08-11', 'not-a-date'],
    activeHours: [2],
    url: 'https://example.com',
    caption: 'secret transcript',
    apiKey: 'secret',
    sites: { 'https://www.youtube.com/watch?v=nope': { durationMs: 3000, sessionCount: 1 } }
  });
  assert.deepEqual(normalized.activeDays, ['2026-08-11']);
  assert.equal(Object.hasOwn(normalized, 'url'), false);
  assert.equal(Object.hasOwn(normalized, 'caption'), false);
  assert.equal(Object.hasOwn(normalized, 'apiKey'), false);
  assert.equal(normalized.sites['youtube.com'].durationMs, 3000);
  assert.equal(Object.hasOwn(normalized.sites, 'https://www.youtube.com/watch?v=nope'), false);
});

test('usage stats aggregate starts, ends, sites, and latency', () => {
  let stats = normalizeUsageStats(EMPTY_USAGE_STATS);
  stats = recordSessionStart(stats, '2026-08-11T17:00:00.000Z', { site: 'https://www.youtube.com/watch?v=abc' });
  stats = recordSessionEnd(stats, {
    durationMs: 120000,
    sentAudioMs: 90000,
    latencyMs: 240,
    reconnectCount: 2,
    site: 'https://www.youtube.com/watch?v=abc',
    endedAt: '2026-08-11T17:02:00.000Z'
  });
  assert.equal(stats.sessionCount, 1);
  assert.equal(stats.totalDurationMs, 120000);
  assert.equal(stats.sentAudioMs, 90000);
  assert.equal(stats.reconnects, 2);
  assert.equal(stats.activeDays.length, 1);
  assert.equal(stats.activeHours[new Date('2026-08-11T17:00:00.000Z').getHours()], 1);
  assert.equal(averageLatency(stats), 240);
  assert.equal(stats.sites['youtube.com'].sessionCount, 1);
  assert.equal(stats.sites['youtube.com'].durationMs, 120000);
  assert.equal(stats.lastSessionSite, 'youtube.com');
  assert.equal(stats.lastSessionLatencyMs, 240);
  assert.equal(stats.longestSessionMs, 120000);
  assert.equal(stats.dailyMinutes[dayKey('2026-08-11T17:02:00.000Z')], 2);
  assert.equal(stats.dailySessions[dayKey('2026-08-11T17:00:00.000Z')], 1);
  assert.equal(stats.sites['youtube.com'].days[dayKey('2026-08-11T17:02:00.000Z')].durationMs, 120000);
  assert.equal(topSites(stats)[0].label, 'YouTube');
});

test('error endings remain numeric and reset cleanly', () => {
  const stats = recordSessionEnd(EMPTY_USAGE_STATS, { durationMs: 500, error: true });
  assert.equal(stats.errorStops, 1);
  assert.equal(stats.normalStops, 0);
  const reset = normalizeUsageStats(EMPTY_USAGE_STATS);
  assert.equal(reset.sessionCount, 0);
  assert.equal(reset.activeHours.length, 24);
  assert.deepEqual(reset.sites, {});
});

test('site key stores host only and week comparison uses daily minutes', () => {
  assert.equal(siteKey('https://www.facebook.com/watch'), 'facebook.com');
  assert.equal(siteKey('https://www.youtube.com/watch?v=abc'), 'youtube.com');
  assert.equal(siteKey('https://www.youtube.com'), 'youtube.com');
  assert.equal(siteKey('chrome-extension://abc/src/stats/stats.html'), null);
  let stats = normalizeUsageStats(EMPTY_USAGE_STATS);
  stats = recordSessionEnd(stats, { durationMs: 600000, site: 'https://coursera.org/learn/x', endedAt: `${dayKey()}T12:00:00` });
  const week = weekComparison(stats, dayKey());
  assert.equal(week.current, 10);
  assert.equal(stats.sites['coursera.org'].durationMs, 600000);
});

test('week session count falls back when daily ledger is missing', () => {
  const today = dayKey();
  const stats = normalizeUsageStats({
    sessionCount: 2,
    dailyMinutes: { [today]: 1 },
    dailySessions: {},
    sites: {}
  });
  assert.equal(sessionsInRange(stats, today, today), 2);
});

test('chart scale hugs the data instead of a fixed hour axis', () => {
  assert.equal(niceScale(0).top, 4);
  assert.equal(niceScale(20).top, 20);
  assert.equal(niceScale(20).unit, 'm');
  assert.ok(niceScale(21).top >= 21 && niceScale(21).top <= 25);
  assert.equal(niceScale(90).top, 90);
  assert.equal(niceScale(120).unit, 'h');
});

test('sites in range use per-day totals when present', () => {
  let stats = normalizeUsageStats(EMPTY_USAGE_STATS);
  stats = recordSessionStart(stats, '2026-08-01T10:00:00.000Z', { site: 'https://www.youtube.com' });
  stats = recordSessionEnd(stats, {
    durationMs: 600000,
    site: 'https://www.youtube.com',
    endedAt: '2026-08-01T10:10:00.000Z'
  });
  stats = recordSessionStart(stats, '2026-08-14T10:00:00.000Z', { site: 'https://vimeo.com' });
  stats = recordSessionEnd(stats, {
    durationMs: 120000,
    site: 'https://vimeo.com',
    endedAt: '2026-08-14T10:02:00.000Z'
  });
  const week = sitesInRange(stats, '2026-08-08', '2026-08-14');
  assert.equal(week.length, 1);
  assert.equal(week[0].label, 'Vimeo');
  assert.equal(week[0].durationMs, 120000);
});

test('last session site is backfilled into the sites list', () => {
  const stats = normalizeUsageStats({
    sessionCount: 3,
    lastSessionDurationMs: 180000,
    lastSessionAt: '2026-08-14T12:00:00.000Z',
    lastSessionSite: 'https://www.youtube.com',
    sites: {}
  });
  assert.equal(stats.lastSessionSite, 'youtube.com');
  assert.equal(stats.sites['youtube.com'].durationMs, 180000);
  assert.equal(topSites(stats)[0].label, 'YouTube');
});
