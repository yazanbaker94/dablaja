// Library export builders — plain text, bilingual SRT, JSON and print data.
// All exports are derived from the local session record only: no API key, no
// audio, no telemetry fields ever appear here (asserted by tests).

import { LIBRARY_SCHEMA_VERSION, sanitizeText } from './library-session.js';

const FORBIDDEN_EXPORT_KEYS = ['apiKey', 'api_key', 'audio', 'pcm', 'base64'];

function assertNoForbiddenFields(value, path = 'root') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_EXPORT_KEYS.includes(key)) {
      throw new Error(`حقل ممنوع في التصدير: ${key} (${path})`);
    }
    assertNoForbiddenFields(nested, `${path}.${key}`);
  }
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

export function toPlainText(session) {
  if (!session) return '';
  const lines = [];
  const title = session.title || 'جلسة دبلجة';
  lines.push(title);
  if (session.siteOrigin) lines.push(session.siteOrigin);
  const created = formatTimestamp(session.createdAt);
  if (created) lines.push(created);
  if (session.durationMs) lines.push(`المدة: ${Math.round(session.durationMs / 1000)} ثانية`);
  lines.push('');
  if (session.notes) {
    lines.push('— الملاحظات —');
    lines.push(session.notes);
    lines.push('');
  }
  if (session.bookmarks?.length) {
    lines.push('— العلامات —');
    for (const bookmark of session.bookmarks) {
      const seconds = Math.floor(bookmark.atMs / 1000);
      const stamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      lines.push(`[${stamp}] ${bookmark.note || '—'}`.trim());
    }
    lines.push('');
  }
  const rows = toBilingualRows(session);
  if (!rows.length) {
    lines.push('لا توجد نصوص محفوظة في هذه الجلسة.');
    return lines.join('\n');
  }
  lines.push('— الترجمة الثنائية —');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    lines.push(`EN: ${row.source || '[لم يصل نص إنجليزي لهذا الجزء]'}`);
    lines.push(`AR: ${row.target || '[لم تصل ترجمة عربية لهذا الجزء]'}`);
    if (index < rows.length - 1) lines.push('');
  }
  return lines.join('\n');
}

export function msToSrtTime(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

const MAX_LEGACY_ALIGNMENT_GAP_MS = 12_000;

function segmentStart(segment) {
  return Math.max(0, Number(segment?.startMs) || 0);
}

function orderedSegments(value) {
  return [...(Array.isArray(value) ? value : [])]
    .filter((segment) => segment && typeof segment.text === 'string' && segment.text.trim())
    .sort((a, b) => segmentStart(a) - segmentStart(b));
}

function validTurnId(segment) {
  return Number.isSafeInteger(segment?.turnId) && segment.turnId >= 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestIndex(segments, timestamp) {
  if (!segments.length) return -1;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (segmentStart(segments[middle]) < timestamp) low = middle + 1;
    else high = middle;
  }
  if (low > 0) {
    const before = Math.abs(segmentStart(segments[low - 1]) - timestamp);
    const after = Math.abs(segmentStart(segments[low]) - timestamp);
    if (before <= after) return low - 1;
  }
  return low;
}

function estimateTranslationLag(source, target) {
  if (!source.length || !target.length) return 0;
  const offsets = [];
  for (const translated of target) {
    const index = nearestIndex(source, segmentStart(translated));
    if (index < 0) continue;
    const offset = segmentStart(translated) - segmentStart(source[index]);
    if (Math.abs(offset) <= MAX_LEGACY_ALIGNMENT_GAP_MS) offsets.push(offset);
  }
  return Math.max(-5_000, Math.min(5_000, median(offsets)));
}

function buildRow(sourceSegments = [], targetSegments = []) {
  const source = orderedSegments(sourceSegments);
  const target = orderedSegments(targetSegments);
  const all = [...source, ...target];
  const starts = all.map(segmentStart);
  const targetStarts = target.map(segmentStart);
  const sourceStarts = source.map(segmentStart);
  const ends = all.map((segment) => Math.max(segmentStart(segment), Number(segment.endMs) || 0));
  return {
    source: source.map((segment) => segment.text.trim()).join(' '),
    target: target.map((segment) => segment.text.trim()).join(' '),
    sourceSegments: source,
    targetSegments: target,
    atMs: targetStarts.length
      ? Math.min(...targetStarts)
      : (sourceStarts.length ? Math.min(...sourceStarts) : null),
    startMs: starts.length ? Math.min(...starts) : 0,
    endMs: ends.length ? Math.max(...ends) : 0,
    missingSource: source.length === 0,
    missingTarget: target.length === 0
  };
}

// Legacy sessions did not store Gemini turn ids. Align the denser stream to
// the sparser stream monotonically by timestamp after estimating the normal
// translation delay. Multiple chunks may therefore share one bilingual row
// instead of being paired incorrectly by array index.
function alignLegacySegments(sourceInput, targetInput) {
  const source = orderedSegments(sourceInput);
  const target = orderedSegments(targetInput);
  if (!source.length) return target.map((segment) => buildRow([], [segment]));
  if (!target.length) return source.map((segment) => buildRow([segment], []));

  const lag = estimateTranslationLag(source, target);
  const sourceIsAnchor = source.length <= target.length;
  const anchors = sourceIsAnchor ? source : target;
  const dense = sourceIsAnchor ? target : source;
  const groups = anchors.map((anchor) => ({
    source: sourceIsAnchor ? [anchor] : [],
    target: sourceIsAnchor ? [] : [anchor]
  }));
  const orphans = [];

  for (const segment of dense) {
    const comparableTime = sourceIsAnchor
      ? segmentStart(segment) - lag
      : segmentStart(segment) + lag;
    const index = nearestIndex(anchors, comparableTime);
    const distance = index < 0
      ? Infinity
      : Math.abs(segmentStart(anchors[index]) - comparableTime);
    if (distance > MAX_LEGACY_ALIGNMENT_GAP_MS) {
      orphans.push(sourceIsAnchor ? buildRow([], [segment]) : buildRow([segment], []));
      continue;
    }
    if (sourceIsAnchor) groups[index].target.push(segment);
    else groups[index].source.push(segment);
  }

  return [
    ...groups.map((group) => buildRow(group.source, group.target)),
    ...orphans
  ].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

export function toBilingualRows(session) {
  if (!session) return [];
  const source = orderedSegments(session.sourceSegments);
  const target = orderedSegments(session.targetSegments);
  const tagged = [...source, ...target].filter(validTurnId);
  if (!tagged.length) return alignLegacySegments(source, target);

  const turns = new Map();
  const sourceLegacy = [];
  const targetLegacy = [];
  for (const segment of source) {
    if (!validTurnId(segment)) {
      sourceLegacy.push(segment);
      continue;
    }
    const group = turns.get(segment.turnId) || { source: [], target: [] };
    group.source.push(segment);
    turns.set(segment.turnId, group);
  }
  for (const segment of target) {
    if (!validTurnId(segment)) {
      targetLegacy.push(segment);
      continue;
    }
    const group = turns.get(segment.turnId) || { source: [], target: [] };
    group.target.push(segment);
    turns.set(segment.turnId, group);
  }
  const exactRows = [...turns.values()].map((group) => buildRow(group.source, group.target));
  return [...exactRows, ...alignLegacySegments(sourceLegacy, targetLegacy)]
    .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

// Bilingual SRT built from the Arabic dub cues; each cue carries the Arabic
// line plus the overlapping English source line when available.
export function toSrt(session) {
  if (!session) return '';
  const cues = toBilingualRows(session).filter((row) => row.targetSegments.length > 0);
  if (!cues.length) return '';
  const blocks = cues.map((cue, index) => {
    // Single-shot finals can carry zero-length ranges; keep cues readable.
    const startMs = Math.min(...cue.targetSegments.map(segmentStart));
    const rawEndMs = Math.max(...cue.targetSegments.map((segment) => Number(segment.endMs) || segmentStart(segment)));
    const endMs = Math.max(rawEndMs, startMs + 800);
    const stamp = `${msToSrtTime(startMs)} --> ${msToSrtTime(endMs)}`;
    const lines = [cue.target];
    if (cue.source) lines.push(cue.source);
    return `${index + 1}\n${stamp}\n${lines.join('\n')}`;
  });
  return blocks.join('\n\n');
}

export function hasSrtTimestamps(session) {
  return toBilingualRows(session).some((row) => row.targetSegments.length > 0);
}

export function toExportJson(session) {
  if (!session) return '';
  const record = {
    app: 'dablaja',
    kind: 'dablaja-plus-session',
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    exportedAt: formatTimestamp(Date.now()),
    session: {
      schemaVersion: session.schemaVersion,
      id: session.id,
      title: sanitizeText(session.title, 200),
      pageUrl: session.pageUrl || '',
      siteOrigin: session.siteOrigin || '',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      durationMs: session.durationMs || 0,
      sourceSegments: session.sourceSegments || [],
      targetSegments: session.targetSegments || [],
      bookmarks: session.bookmarks || [],
      notes: session.notes || ''
    }
  };
  assertNoForbiddenFields(record);
  return JSON.stringify(record, null, 2);
}

// Rows for the print-friendly view (rendered by the library page).
export function toPrintRows(session) {
  return toBilingualRows(session).map((row) => ({
    source: row.source,
    target: row.target,
    atMs: row.atMs,
    missingSource: row.missingSource,
    missingTarget: row.missingTarget
  }));
}
