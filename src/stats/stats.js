import {
  averageLatency,
  averageSessionMs,
  dayKey,
  dayStrip,
  minutesInRange,
  monthComparison,
  niceScale,
  rangeWindow,
  sessionsInRange,
  siteLabel,
  sitesInRange,
  streakDays,
  weekComparison,
  weekStrip
} from '../shared/usage-stats.js';

const elements = {
  totalDuration: document.querySelector('#totalDuration'),
  weekDelta: document.querySelector('#weekDelta'),
  spark: document.querySelector('#spark'),
  lastSessionWhen: document.querySelector('#lastSessionWhen'),
  lastSessionSite: document.querySelector('#lastSessionSite'),
  lastSessionAgo: document.querySelector('#lastSessionAgo'),
  lastSessionBadge: document.querySelector('#lastSessionBadge'),
  averageSession: document.querySelector('#averageSession'),
  sessionCount: document.querySelector('#sessionCount'),
  averageLatency: document.querySelector('#averageLatency'),
  streak: document.querySelector('#streak'),
  siteList: document.querySelector('#siteList'),
  siteEmpty: document.querySelector('#siteEmpty'),
  siteTotalRow: document.querySelector('#siteTotalRow'),
  weekY: document.querySelector('#weekY'),
  weekStrip: document.querySelector('#weekStrip'),
  activityTitle: document.querySelector('#activityTitle'),
  activityTotalLabel: document.querySelector('#activityTotalLabel'),
  weekAvg: document.querySelector('#weekAvg'),
  weekLongestDay: document.querySelector('#weekLongestDay'),
  weekLongestDur: document.querySelector('#weekLongestDur'),
  weekTotal: document.querySelector('#weekTotal'),
  detailSite: document.querySelector('#detailSite'),
  detailDuration: document.querySelector('#detailDuration'),
  detailLatency: document.querySelector('#detailLatency'),
  detailDate: document.querySelector('#detailDate'),
  detailTime: document.querySelector('#detailTime'),
  clearStats: document.querySelector('#clearStats'),
  openFeedback: document.querySelector('#openFeedback'),
  reviewCta: document.querySelector('#reviewCta'),
  statsPlusCard: document.querySelector('#statsPlusCard'),
  statsUpgradeBtn: document.querySelector('#statsUpgradeBtn'),
  statsPlusTitle: document.querySelector('#statsPlusTitle'),
  statsPlusDesc: document.querySelector('#statsPlusDesc'),
  clearMessage: document.querySelector('#clearMessage'),
  tip: document.querySelector('#tip'),
  range: document.querySelector('.range')
};

const RANGE_KEY = 'dablajaStatsRange';
let currentRange = 'week';
try { currentRange = sessionStorage.getItem(RANGE_KEY) || 'week'; } catch {}
let currentStats = null;
let statsPlusEnabled = false;

const WEEKDAY = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 6v12l11-6z"/></svg>',
  vimeo: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.5 4c2.6.1 4 1.8 3.3 4.6-.8 3.2-2.9 6.3-5.3 8.6-2.3 2.2-4.4 3.3-6.1 3.3-1 0-1.8-.9-2.5-2.6L4 13.4c.5 0 1.1.1 1.8.1 1.2 0 2.3-.7 3.3-2.2.6-1.1.9-2 .4-2.4-.3-.3-.8 0-1.4.5l-.8-1.7C8.7 5.4 10.3 4 12.5 4c.7 0 1.6.2 2.4.6.6.3 1.1.4 1.6.4z"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm6.9 9h-3.1a15 15 0 0 0-1.3-6 8 8 0 0 1 4.4 6zM12 4.1A13 13 0 0 1 13.8 11H10.2A13 13 0 0 1 12 4.1zM4.1 13a8 8 0 0 1 4.4-6 15 15 0 0 0-1.3 6H4.1zm6.1 0h3.6A13 13 0 0 1 12 19.9 13 13 0 0 1 10.2 13z"/></svg>'
};

function arDigits(value) {
  return String(value).replace(/[0-9]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'[digit]);
}

function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours && minutes) return `${arDigits(hours)} س ${arDigits(minutes)} د`;
  if (hours) return `${arDigits(hours)} س`;
  return `${arDigits(minutes)} د`;
}

function formatLatency(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  return `${arDigits(Math.round(Number(ms)))}ms≈`;
}

function siteKind(host = '') {
  const value = String(host).toLowerCase();
  if (value.includes('youtube') || value === 'youtu.be') return 'youtube';
  if (value.includes('vimeo')) return 'vimeo';
  if (value.includes('facebook') || value === 'fb.com') return 'facebook';
  if (value.includes('instagram')) return 'instagram';
  if (value.includes('netflix')) return 'netflix';
  if (value.includes('twitch')) return 'twitch';
  return host ? 'other' : 'empty';
}

function markIcon(kind) {
  if (kind === 'vimeo') return ICONS.vimeo;
  if (kind === 'youtube') return ICONS.play;
  return ICONS.globe;
}

function setBadge(node, host) {
  const kind = siteKind(host);
  node.dataset.kind = kind;
  node.innerHTML = markIcon(kind);
}

function formatAgo(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `منذ ${arDigits(minutes)} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${arDigits(hours)} ساعة`;
  return `منذ ${arDigits(Math.round(hours / 24))} يوم`;
}

function formatWhen(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  if (dayKey(then) === dayKey()) return 'اليوم';
  if (dayKey(then) === dayKey(Date.now() - 86400000)) return 'أمس';
  return `${arDigits(then.getDate())} ${MONTHS[then.getMonth()]}`;
}

function formatDate(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  return `${arDigits(then.getDate())} ${MONTHS[then.getMonth()]} ${arDigits(then.getFullYear())}`;
}

function formatTime(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const hours24 = then.getHours();
  const minutes = String(then.getMinutes()).padStart(2, '0');
  const hours = hours24 % 12 || 12;
  return `${arDigits(hours)}:${arDigits(minutes)} ${hours24 >= 12 ? 'م' : 'ص'}`;
}

function hideTip() {
  elements.tip.classList.add('hidden');
}

function showTip(lines, event) {
  elements.tip.replaceChildren();
  lines.forEach((line, index) => {
    const node = document.createElement(index === 0 ? 'b' : 'span');
    node.textContent = line;
    elements.tip.append(node);
  });
  elements.tip.classList.remove('hidden');
  const width = elements.tip.offsetWidth;
  const height = elements.tip.offsetHeight;
  let left = event.clientX - width / 2;
  let top = event.clientY - height - 14;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  if (top < 8) top = event.clientY + 16;
  elements.tip.style.left = `${left}px`;
  elements.tip.style.top = `${top}px`;
}

function bindTip(node, lines) {
  node.addEventListener('pointerenter', (event) => showTip(lines, event));
  node.addEventListener('pointermove', (event) => showTip(lines, event));
  node.addEventListener('pointerleave', hideTip);
}

function renderSpark(cells) {
  const peak = Math.max(...cells.map((cell) => cell.minutes), 1);
  elements.spark.replaceChildren();
  for (const cell of cells) {
    const bar = document.createElement('i');
    bar.style.height = `${Math.max(6, Math.round((cell.minutes / peak) * 100))}%`;
    if (cell.minutes) bar.classList.add('on');
    elements.spark.append(bar);
  }
}

function activityCells(stats, range, today) {
  if (range === 'month') {
    const window = rangeWindow('month', today);
    return dayStrip(stats, window.from, window.to);
  }
  return weekStrip(stats, today);
}

function renderSites(stats, range) {
  const window = rangeWindow(range);
  const rows = sitesInRange(stats, window.from, window.to, 3);
  const allRows = sitesInRange(stats, window.from, window.to, 40);
  const total = allRows.reduce((sum, row) => sum + row.durationMs, 0);
  const shown = rows.reduce((sum, row) => sum + row.durationMs, 0);
  const leftoverMs = Math.max(0, total - shown);
  const leftoverSessions = Math.max(0, allRows.slice(3).reduce((sum, row) => sum + (row.sessionCount || 0), 0));
  elements.siteList.replaceChildren();
  const hasRows = rows.length > 0;
  elements.siteEmpty.classList.toggle('hidden', hasRows);
  elements.siteTotalRow.classList.toggle('hidden', !hasRows);
  if (!hasRows) {
    elements.siteEmpty.textContent = stats.sessionCount
      ? 'لا مواقع في هذه الفترة. ابدأ الدبلجة مرة على يوتيوب وستظهر هنا.'
      : 'ابدأ الدبلجة على يوتيوب أو أي موقع، وستظهر هنا.';
    return;
  }

  const items = leftoverMs > 0
    ? [...rows, { host: '', label: 'غير ذلك', durationMs: leftoverMs, sessionCount: leftoverSessions }]
    : rows;
  const peak = Math.max(...items.map((row) => row.durationMs), 1);
  for (const row of items) {
    const share = total > 0 ? (row.durationMs / total) * 100 : 0;
    const item = document.createElement('div');
    item.className = 'site-row';
    const kind = row.host ? siteKind(row.host) : 'other';
    item.innerHTML = `<span class="site-id"><span class="site-mark" data-kind="${kind}">${markIcon(kind)}</span><em></em></span><div class="bar"><i></i></div><b></b>`;
    item.querySelector('em').textContent = row.label;
    item.querySelector('i').style.width = `${Math.max(4, Math.round((row.durationMs / peak) * 100))}%`;
    item.querySelector('b').textContent = share < 1 ? '< ١٪' : `٪${arDigits(Math.round(share))}`;
    bindTip(item, [
      row.label,
      formatDuration(row.durationMs),
      `${arDigits(row.sessionCount || 0)} جلسات`
    ]);
    elements.siteList.append(item);
  }
}

function formatTick(value, unit) {
  if (unit === 'h') return `${arDigits(Math.round(value / 60))} س`;
  return `${arDigits(value)} د`;
}

function scaleTicks(top, unit) {
  const steps = top <= 1 ? [1, 0] : top <= 2 ? [2, 1, 0] : top <= 3 ? [3, 2, 1, 0] : [4, 3, 2, 1, 0].map((step) => Math.round((top * step) / 4));
  return [...new Set(steps)].map((value) => formatTick(value, unit));
}

function renderWeek(stats, range) {
  const today = dayKey();
  const cells = activityCells(stats, range, today);
  const maxMinutes = Math.max(...cells.map((cell) => cell.minutes), 0);
  const scale = niceScale(maxMinutes);
  const ticks = scaleTicks(scale.top, scale.unit);
  elements.weekY.replaceChildren();
  for (const tick of ticks) {
    const label = document.createElement('span');
    label.textContent = tick;
    elements.weekY.append(label);
  }

  const titles = {
    week: 'نشاطك هذا الأسبوع',
    month: 'نشاطك هذا الشهر',
    all: 'آخر ٧ أيام'
  };
  const totals = {
    week: 'إجمالي هذا الأسبوع',
    month: 'إجمالي هذا الشهر',
    all: 'إجمالي آخر ٧ أيام'
  };
  elements.activityTitle.textContent = titles[range] || titles.week;
  elements.activityTotalLabel.textContent = totals[range] || totals.week;

  elements.weekStrip.replaceChildren();
  elements.weekStrip.classList.toggle('dense', cells.length > 10);
  elements.weekStrip.style.gridTemplateColumns = `repeat(${Math.max(cells.length, 1)}, 1fr)`;
  for (const cell of cells) {
    const wrap = document.createElement('div');
    wrap.className = 'week-cell';
    const col = document.createElement('div');
    col.className = 'col';
    const bar = document.createElement('b');
    if (cell.minutes) {
      bar.style.height = `${Math.max(8, Math.round((cell.minutes / scale.top) * 100))}%`;
    } else {
      bar.classList.add('zero');
      bar.style.height = '3px';
    }
    if (cell.day === today) bar.classList.add('today');
    col.append(bar);
    const label = document.createElement('em');
    const date = new Date(`${cell.day}T12:00:00`);
    label.textContent = cells.length > 10 ? arDigits(date.getDate()) : WEEKDAY[date.getDay()];
    wrap.append(col, label);
    bindTip(wrap, [
      WEEKDAY[date.getDay()],
      `${arDigits(cell.minutes)} دقيقة`,
      `${arDigits(cell.sessions || 0)} جلسات`
    ]);
    elements.weekStrip.append(wrap);
  }

  const totalMinutes = cells.reduce((sum, cell) => sum + cell.minutes, 0);
  const longest = cells.reduce((best, cell) => (cell.minutes >= (best?.minutes || 0) ? cell : best), cells[0]);
  const divisor = Math.max(cells.length, 1);
  const avgMs = (totalMinutes / divisor) * 60000;
  elements.weekAvg.textContent = totalMinutes && avgMs < 30000 ? 'أقل من ١ د' : formatDuration(avgMs);
  elements.weekTotal.textContent = formatDuration(totalMinutes * 60000);
  if (longest?.minutes) {
    elements.weekLongestDay.textContent = WEEKDAY[new Date(`${longest.day}T12:00:00`).getDay()];
    elements.weekLongestDur.textContent = formatDuration(longest.minutes * 60000);
  } else {
    elements.weekLongestDay.textContent = '—';
    elements.weekLongestDur.textContent = '٠ د';
  }
  renderSpark(cells);
}

function renderLastSession(stats) {
  if (!stats.lastSessionAt) {
    elements.lastSessionWhen.textContent = '—';
    elements.lastSessionSite.textContent = 'لم تبدأ بعد';
    elements.lastSessionAgo.textContent = '—';
    elements.lastSessionAgo.hidden = true;
    setBadge(elements.lastSessionBadge, '');
    elements.detailSite.textContent = '—';
    elements.detailDuration.textContent = '—';
    elements.detailLatency.textContent = '—';
    elements.detailDate.textContent = '—';
    elements.detailTime.textContent = '—';
    return;
  }

  const site = stats.lastSessionSite ? siteLabel(stats.lastSessionSite) : 'موقع آخر';
  elements.lastSessionWhen.textContent = formatWhen(stats.lastSessionAt);
  elements.lastSessionSite.textContent = site;
  elements.lastSessionAgo.hidden = false;
  elements.lastSessionAgo.textContent = formatAgo(stats.lastSessionAt);
  setBadge(elements.lastSessionBadge, stats.lastSessionSite);
  elements.detailSite.innerHTML = '';
  const detail = document.createElement('span');
  detail.className = 'site-id';
  detail.innerHTML = `<span class="site-mark" data-kind="${siteKind(stats.lastSessionSite)}">${markIcon(siteKind(stats.lastSessionSite))}</span>`;
  detail.append(document.createTextNode(site));
  elements.detailSite.append(detail);
  elements.detailDuration.textContent = formatDuration(stats.lastSessionDurationMs);
  elements.detailLatency.textContent = formatLatency(stats.lastSessionLatencyMs ?? averageLatency(stats));
  elements.detailDate.textContent = formatDate(stats.lastSessionAt);
  elements.detailTime.textContent = formatTime(stats.lastSessionAt);
}

function setRangeButtons() {
  for (const button of elements.range.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.range === currentRange);
  }
}

function renderDelta(stats, range, today) {
  if (range === 'all') {
    elements.weekDelta.textContent = 'كل الوقت';
    elements.weekDelta.classList.remove('down');
    return;
  }
  const compared = range === 'month' ? monthComparison(stats, today) : weekComparison(stats, today);
  const label = range === 'month' ? 'عن الشهر الماضي' : 'عن الأسبوع الماضي';
  if (compared.previous || compared.current) {
    const up = compared.delta >= 0;
    const percent = compared.previous
      ? Math.round((Math.abs(compared.delta) / compared.previous) * 100)
      : 100;
    elements.weekDelta.textContent = `${up ? '↑' : '↓'} ٪${arDigits(percent)} ${label}`;
    elements.weekDelta.classList.toggle('down', !up && compared.delta !== 0);
  } else {
    elements.weekDelta.textContent = range === 'month' ? 'أول شهر لك' : 'أول أسبوع لك';
    elements.weekDelta.classList.remove('down');
  }
}

function render(stats) {
  currentStats = stats;
  const today = dayKey();
  const window = rangeWindow(currentRange, today);
  const rangedMinutes = currentRange === 'all'
    ? Math.round((stats.totalDurationMs || 0) / 60000)
    : minutesInRange(stats, window.from, window.to);
  const rangedSessions = currentRange === 'all'
    ? stats.sessionCount || 0
    : sessionsInRange(stats, window.from, window.to);
  elements.totalDuration.textContent = currentRange === 'all'
    ? formatDuration(stats.totalDurationMs)
    : formatDuration(rangedMinutes * 60000);
  renderDelta(stats, currentRange, today);
  const averageMs = rangedSessions
    ? Math.round(((currentRange === 'all' ? stats.totalDurationMs : rangedMinutes * 60000) / rangedSessions))
    : 0;
  elements.averageSession.textContent = formatDuration(currentRange === 'all' ? averageSessionMs(stats) : averageMs);
  elements.sessionCount.textContent = `${arDigits(rangedSessions)} جلسات`;
  elements.averageLatency.textContent = formatLatency(averageLatency(stats));
  elements.streak.textContent = `${arDigits(streakDays(stats, today))} أيام متتالية`;
  setRangeButtons();
  renderLastSession(stats);
  renderSites(stats, currentRange);
  renderWeek(stats, currentRange);
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'تعذر تحميل الإحصائيات.');
  return response;
}

request({ type: 'GET_STATS' })
  .then((response) => render(response.stats))
  .catch(() => render({
    totalDurationMs: 0,
    sessionCount: 0,
    activeDays: [],
    activeHours: [],
    dailyMinutes: {},
    sites: {}
  }));

elements.range.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button || button.dataset.range === currentRange) return;
  currentRange = button.dataset.range;
  try { sessionStorage.setItem(RANGE_KEY, currentRange); } catch {}
  hideTip();
  if (currentStats) render(currentStats);
});

let transientMessageTimer = null;

function showTransientMessage(message) {
  clearTimeout(transientMessageTimer);
  elements.tip.textContent = String(message || 'تعذر تنفيذ الطلب. حاول مجدداً.');
  elements.tip.style.left = '50%';
  elements.tip.style.top = '16px';
  elements.tip.style.transform = 'translateX(-50%)';
  elements.tip.classList.remove('hidden');
  transientMessageTimer = setTimeout(() => {
    elements.tip.classList.add('hidden');
    elements.tip.style.transform = '';
  }, 3500);
}

async function openLibraryPage() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/library/library.html') });
    return true;
  } catch (error) {
    showTransientMessage(error?.message || 'تعذر فتح مكتبة Plus. حاول مجدداً.');
    return false;
  }
}

async function openFeedbackPage() {
  try {
    const response = await request({ type: 'GET_FEEDBACK_URL', source: 'stats' });
    if (!response.url) throw new Error('تعذر إنشاء رابط الملاحظات.');
    await chrome.tabs.create({ url: response.url });
  } catch (error) {
    showTransientMessage(error?.message || 'تعذر فتح صفحة الملاحظات. حاول مجدداً.');
  }
}

elements.openFeedback?.addEventListener('click', openFeedbackPage);
elements.reviewCta?.addEventListener('click', openFeedbackPage);

document.querySelector('#openLibrary')?.addEventListener('click', async () => {
  await openLibraryPage();
});

elements.statsUpgradeBtn?.addEventListener('click', async () => {
  if (elements.statsUpgradeBtn.disabled) return;
  if (statsPlusEnabled) {
    await openLibraryPage();
    return;
  }
  elements.statsUpgradeBtn.disabled = true;
  try {
    await request({ type: 'PLUS_START_CHECKOUT' });
  } catch (e) {
    showTransientMessage(e?.message || 'تعذر إنشاء جلسة الدفع. حاول لاحقاً.');
  } finally {
    elements.statsUpgradeBtn.disabled = false;
  }
});

async function checkPlusStatus() {
  try {
    const res = await request({ type: 'GET_STATE' });
    if (res?.plus?.entitlement?.plusEnabled === true) {
      statsPlusEnabled = true;
      if (elements.statsPlusTitle) elements.statsPlusTitle.textContent = 'أنت مشترك في dablaja Plus';
      if (elements.statsPlusDesc) elements.statsPlusDesc.textContent = 'ترخيص مدى الحياة مفعّل على هذا الجهاز. شكراً لدعمك!';
      if (elements.statsUpgradeBtn) {
        elements.statsUpgradeBtn.innerHTML = '<span>فتح مكتبة Plus 💎</span>';
      }
    }
  } catch {
    statsPlusEnabled = false;
  }
}

checkPlusStatus();

elements.clearStats.addEventListener('click', async () => {
  elements.clearStats.disabled = true;
  try {
    const response = await request({ type: 'CLEAR_STATS' });
    render(response.stats);
    elements.clearMessage.textContent = 'تم المسح من هذا الجهاز.';
    elements.clearMessage.classList.remove('hidden');
  } catch (error) {
    showTransientMessage(error?.message || 'تعذر مسح الإحصائيات. حاول مجدداً.');
  } finally {
    elements.clearStats.disabled = false;
  }
});
