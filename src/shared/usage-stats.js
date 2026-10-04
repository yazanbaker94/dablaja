export const EMPTY_USAGE_STATS = Object.freeze({
  totalDurationMs: 0,
  sessionCount: 0,
  activeDays: [],
  activeHours: Array(24).fill(0),
  sentAudioMs: 0,
  latencyTotalMs: 0,
  latencySamples: 0,
  reconnects: 0,
  normalStops: 0,
  errorStops: 0,
  lastSessionAt: null,
  firstSessionAt: null,
  lastSessionDurationMs: 0,
  lastSessionSite: null,
  lastSessionLatencyMs: null,
  longestSessionMs: 0,
  dailyMinutes: {},
  dailySessions: {},
  sites: {}
});

export const SITE_LABELS = Object.freeze({
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'm.youtube.com': 'YouTube',
  'music.youtube.com': 'YouTube Music',
  'facebook.com': 'Facebook',
  'fb.com': 'Facebook',
  'm.facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'coursera.org': 'Coursera',
  'udemy.com': 'Udemy',
  'edx.org': 'edX',
  'khanacademy.org': 'Khan Academy',
  'meet.google.com': 'Google Meet',
  'zoom.us': 'Zoom',
  'teams.microsoft.com': 'Teams',
  'netflix.com': 'Netflix',
  'twitch.tv': 'Twitch',
  'vimeo.com': 'Vimeo',
  'ted.com': 'TED',
  'linkedin.com': 'LinkedIn',
  'tiktok.com': 'TikTok',
  'x.com': 'X',
  'twitter.com': 'X',
  'discord.com': 'Discord',
  'drive.google.com': 'Google Drive',
  'docs.google.com': 'Google Docs'
});

function safeNonNegative(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function siteKey(origin) {
  if (!origin || typeof origin !== 'string') return null;
  try {
    const parsed = new URL(origin.includes('://') ? origin : `https://${origin}`);
    if (parsed.protocol && !/^https?:$/.test(parsed.protocol)) return null;
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return null;
    return host.slice(0, 80);
  } catch {
    return null;
  }
}

export function siteLabel(host) {
  if (!host) return 'موقع آخر';
  return SITE_LABELS[host] || host;
}

function normalizeDailyMinutes(value) {
  const source = value && typeof value === 'object' ? value : {};
  const next = {};
  for (const [day, minutes] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    next[day] = Math.floor(safeNonNegative(minutes));
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)).slice(-120));
}

function normalizeSiteDays(value) {
  const source = value && typeof value === 'object' ? value : {};
  const next = {};
  for (const [day, row] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const cell = row && typeof row === 'object' ? row : {};
    next[day] = {
      durationMs: safeNonNegative(cell.durationMs),
      sessionCount: Math.floor(safeNonNegative(cell.sessionCount))
    };
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)).slice(-120));
}

function normalizeSites(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rows = [];
  for (const [host, row] of Object.entries(source)) {
    const key = siteKey(host);
    if (!key || !row || typeof row !== 'object') continue;
    rows.push({
      host: key,
      durationMs: safeNonNegative(row.durationMs),
      sessionCount: Math.floor(safeNonNegative(row.sessionCount)),
      lastAt: typeof row.lastAt === 'string' ? row.lastAt : null,
      days: normalizeSiteDays(row.days)
    });
  }
  rows.sort((a, b) => b.durationMs - a.durationMs || b.sessionCount - a.sessionCount);
  const next = {};
  for (const row of rows.slice(0, 40)) {
    next[row.host] = {
      durationMs: row.durationMs,
      sessionCount: row.sessionCount,
      lastAt: row.lastAt,
      days: row.days
    };
  }
  return next;
}

function touchSite(sites, host, patch = {}) {
  if (!host) return sites;
  const current = sites[host] || { durationMs: 0, sessionCount: 0, lastAt: null, days: {} };
  const days = { ...(current.days || {}) };
  if (patch.day) {
    const prev = days[patch.day] || { durationMs: 0, sessionCount: 0 };
    days[patch.day] = {
      durationMs: prev.durationMs + safeNonNegative(patch.durationMs),
      sessionCount: prev.sessionCount + Math.floor(safeNonNegative(patch.sessionCount))
    };
  }
  sites[host] = {
    durationMs: current.durationMs + safeNonNegative(patch.durationMs),
    sessionCount: current.sessionCount + Math.floor(safeNonNegative(patch.sessionCount)),
    lastAt: patch.lastAt || current.lastAt,
    days: normalizeSiteDays(days)
  };
  return sites;
}

export function normalizeUsageStats(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const next = {
    totalDurationMs: safeNonNegative(source.totalDurationMs),
    sessionCount: Math.floor(safeNonNegative(source.sessionCount)),
    activeDays: Array.isArray(source.activeDays)
      ? [...new Set(source.activeDays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort().slice(-366)
      : [],
    activeHours: Array.from({ length: 24 }, (_, hour) => Math.floor(safeNonNegative(source.activeHours?.[hour]))),
    sentAudioMs: safeNonNegative(source.sentAudioMs),
    latencyTotalMs: safeNonNegative(source.latencyTotalMs),
    latencySamples: Math.floor(safeNonNegative(source.latencySamples)),
    reconnects: Math.floor(safeNonNegative(source.reconnects)),
    normalStops: Math.floor(safeNonNegative(source.normalStops)),
    errorStops: Math.floor(safeNonNegative(source.errorStops)),
    lastSessionAt: typeof source.lastSessionAt === 'string' ? source.lastSessionAt : null,
    firstSessionAt: typeof source.firstSessionAt === 'string' ? source.firstSessionAt : null,
    lastSessionDurationMs: safeNonNegative(source.lastSessionDurationMs),
    lastSessionSite: siteKey(source.lastSessionSite),
    lastSessionLatencyMs: source.lastSessionLatencyMs == null ? null : safeNonNegative(source.lastSessionLatencyMs),
    longestSessionMs: safeNonNegative(source.longestSessionMs),
    dailyMinutes: normalizeDailyMinutes(source.dailyMinutes),
    dailySessions: normalizeDailyMinutes(source.dailySessions),
    sites: normalizeSites(source.sites)
  };
  if (next.lastSessionSite && !next.sites[next.lastSessionSite]) {
    const day = next.lastSessionAt ? dayKey(next.lastSessionAt) : null;
    next.sites[next.lastSessionSite] = {
      durationMs: next.lastSessionDurationMs,
      sessionCount: 1,
      lastAt: next.lastSessionAt,
      days: day ? { [day]: { durationMs: next.lastSessionDurationMs, sessionCount: 1 } } : {}
    };
  }
  return next;
}

export function recordSessionStart(stats, startedAt, extra = {}) {
  const next = normalizeUsageStats(stats);
  const when = startedAt || Date.now();
  const day = dayKey(when);
  if (day && !next.activeDays.includes(day)) next.activeDays.push(day);
  const hour = new Date(when).getHours();
  if (hour >= 0 && hour < 24) next.activeHours[hour] += 1;
  next.sessionCount += 1;
  if (day) {
    next.dailySessions = { ...next.dailySessions, [day]: (next.dailySessions[day] || 0) + 1 };
    next.dailySessions = normalizeDailyMinutes(next.dailySessions);
  }
  const stamp = new Date(when).toISOString();
  next.lastSessionAt = stamp;
  if (!next.firstSessionAt) next.firstSessionAt = stamp;
  const host = siteKey(extra.site);
  if (host) {
    next.lastSessionSite = host;
    next.sites = touchSite({ ...next.sites }, host, { sessionCount: 1, lastAt: stamp, day });
  }
  return next;
}

export function recordSessionEnd(stats, summary = {}) {
  const next = normalizeUsageStats(stats);
  const durationMs = safeNonNegative(summary.durationMs);
  next.totalDurationMs += durationMs;
  next.sentAudioMs += safeNonNegative(summary.sentAudioMs);
  next.latencyTotalMs += safeNonNegative(summary.latencyMs);
  next.latencySamples += summary.latencyMs == null ? 0 : 1;
  next.reconnects += Math.floor(safeNonNegative(summary.reconnectCount));
  if (summary.error) next.errorStops += 1;
  else next.normalStops += 1;
  next.lastSessionDurationMs = durationMs;
  next.lastSessionLatencyMs = summary.latencyMs == null ? null : safeNonNegative(summary.latencyMs);
  if (durationMs > next.longestSessionMs) next.longestSessionMs = durationMs;

  const day = dayKey(summary.endedAt || Date.now());
  if (day) {
    const added = Math.round(durationMs / 60000);
    next.dailyMinutes = { ...next.dailyMinutes, [day]: (next.dailyMinutes[day] || 0) + added };
    next.dailyMinutes = normalizeDailyMinutes(next.dailyMinutes);
  }

  const host = siteKey(summary.site) || next.lastSessionSite;
  if (host) {
    next.lastSessionSite = host;
    next.sites = touchSite({ ...next.sites }, host, {
      durationMs,
      lastAt: new Date(summary.endedAt || Date.now()).toISOString(),
      day
    });
    next.sites = normalizeSites(next.sites);
  }
  return next;
}

export function averageLatency(stats) {
  const normalized = normalizeUsageStats(stats);
  return normalized.latencySamples ? Math.round(normalized.latencyTotalMs / normalized.latencySamples) : null;
}

export function averageSessionMs(stats) {
  const normalized = normalizeUsageStats(stats);
  return normalized.sessionCount ? Math.round(normalized.totalDurationMs / normalized.sessionCount) : 0;
}

export function minutesInRange(stats, fromDay, toDay) {
  const days = normalizeUsageStats(stats).dailyMinutes;
  let total = 0;
  for (const [day, minutes] of Object.entries(days)) {
    if ((!fromDay || day >= fromDay) && (!toDay || day <= toDay)) total += minutes;
  }
  return total;
}

export function sessionsInRange(stats, fromDay, toDay) {
  const normalized = normalizeUsageStats(stats);
  const days = normalized.dailySessions;
  const hasLedger = Object.keys(days).length > 0;
  if (hasLedger) {
    let total = 0;
    for (const [day, count] of Object.entries(days)) {
      if ((!fromDay || day >= fromDay) && (!toDay || day <= toDay)) total += count;
    }
    return total;
  }
  if (!fromDay) return normalized.sessionCount;
  const rangeMinutes = minutesInRange(normalized, fromDay, toDay);
  if (!rangeMinutes) return 0;
  const allMinutes = Object.values(normalized.dailyMinutes).reduce((sum, minutes) => sum + minutes, 0);
  if (rangeMinutes === allMinutes) return normalized.sessionCount;
  return Object.entries(normalized.dailyMinutes)
    .filter(([day, minutes]) => minutes > 0 && day >= fromDay && day <= toDay)
    .length;
}

function shiftDay(day, delta) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}

export function rangeWindow(range, today = dayKey()) {
  if (range === 'month') {
    const from = `${today.slice(0, 7)}-01`;
    const prevEnd = shiftDay(from, -1);
    return {
      from,
      to: today,
      previousFrom: `${prevEnd.slice(0, 7)}-01`,
      previousTo: prevEnd
    };
  }
  if (range === 'all') {
    return { from: null, to: today, previousFrom: null, previousTo: null };
  }
  return {
    from: shiftDay(today, -6),
    to: today,
    previousFrom: shiftDay(today, -13),
    previousTo: shiftDay(today, -7)
  };
}

export function weekComparison(stats, today = dayKey()) {
  const window = rangeWindow('week', today);
  const current = minutesInRange(stats, window.from, window.to);
  const previous = minutesInRange(stats, window.previousFrom, window.previousTo);
  return { current, previous, delta: current - previous };
}

export function monthComparison(stats, today = dayKey()) {
  const window = rangeWindow('month', today);
  const current = minutesInRange(stats, window.from, window.to);
  const previous = minutesInRange(stats, window.previousFrom, window.previousTo);
  return { current, previous, delta: current - previous };
}

export function sitesInRange(stats, fromDay, toDay, limit = 6) {
  const sites = normalizeUsageStats(stats).sites;
  const hasDaySplits = Object.values(sites).some((row) => Object.keys(row.days || {}).length);
  const rows = [];
  for (const [host, row] of Object.entries(sites)) {
    if (!fromDay || !hasDaySplits) {
      rows.push({ host, label: siteLabel(host), durationMs: row.durationMs, sessionCount: row.sessionCount });
      continue;
    }
    let durationMs = 0;
    let sessionCount = 0;
    for (const [day, cell] of Object.entries(row.days || {})) {
      if (day >= fromDay && day <= toDay) {
        durationMs += cell.durationMs;
        sessionCount += cell.sessionCount;
      }
    }
    if (durationMs || sessionCount) {
      rows.push({ host, label: siteLabel(host), durationMs, sessionCount });
    }
  }
  return rows
    .sort((a, b) => b.durationMs - a.durationMs || b.sessionCount - a.sessionCount)
    .slice(0, limit);
}

export function topSites(stats, limit = 6) {
  return sitesInRange(stats, null, null, limit);
}

export function niceScale(maxMinutes) {
  const value = Math.max(0, Number(maxMinutes) || 0);
  if (value <= 0) return { top: 4, unit: 'm' };
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720, 960, 1200, 1440];
  const top = steps.find((step) => step >= value) || Math.ceil(value / 60) * 60;
  return { top, unit: top >= 120 ? 'h' : 'm' };
}

export function streakDays(stats, today = dayKey()) {
  const active = new Set(normalizeUsageStats(stats).activeDays);
  let streak = 0;
  let cursor = today;
  while (active.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

export function dayStrip(stats, fromDay, toDay) {
  const normalized = normalizeUsageStats(stats);
  const minutes = normalized.dailyMinutes;
  const sessions = normalized.dailySessions;
  const cells = [];
  if (!fromDay || !toDay) return cells;
  for (let day = fromDay; day <= toDay; day = shiftDay(day, 1)) {
    const mins = minutes[day] || 0;
    cells.push({
      day,
      minutes: mins,
      sessions: sessions[day] || (mins ? 1 : 0)
    });
  }
  return cells;
}

export function weekStrip(stats, today = dayKey()) {
  return dayStrip(stats, shiftDay(today, -6), today);
}
