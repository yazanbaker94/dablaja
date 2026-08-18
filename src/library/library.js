import { STORAGE_KEYS, SESSION_STORAGE_KEYS } from '../shared/constants.js';
import { describeEntitlement, ENTITLEMENT_STATES, PLUS_PRICE_LABEL } from '../shared/plus-entitlement.js';
import { transcriptLineCount, validateSessionRecord } from '../shared/plus-session.js';
import { createNoteFlushController } from '../shared/note-flush.js';
import { searchSessions, searchTranscriptRows, sessionSummary } from '../shared/plus-search.js';
import { hasSrtTimestamps, toExportJson, toPlainText, toPrintRows, toSrt } from '../shared/plus-export.js';
import { createBackup } from '../shared/plus-backup.js';
import {
  clearSavedSessions,
  deleteSavedSession,
  estimatePlusStorage,
  getSavedSession,
  listSavedSessions
} from '../shared/plus-db.js';

const $ = (id) => document.getElementById(id);
const elements = {
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  menuButton: $('menuButton'),
  navMomentsCount: $('navMomentsCount'),
  quickStatsCard: $('quickStatsCard'),
  statSessions: $('statSessions'),
  statTime: $('statTime'),
  statSites: $('statSites'),
  statMoments: $('statMoments'),
  storageCard: $('storageCard'),
  storageValue: $('storageValue'),
  storageFill: $('storageFill'),
  plusCard: $('plusCard'),
  plusState: $('plusState'),
  entitlementNotice: $('lockedNotice'),
  draftSection: $('draftSection'),
  draftMeta: $('draftMeta'),
  draftBody: $('draftBody'),
  saveStatus: $('saveStatus'),
  searchInput: $('searchInput'),
  searchStatus: $('searchStatus'),
  categoryChips: $('categoryChips'),
  sortDate: $('sortDate'),
  filterDuration: $('filterDuration'),
  filterSite: $('filterSite'),
  resetFilters: $('resetFilters'),
  sessionGrid: $('sessionGrid'),
  emptyState: $('emptyState'),
  emptyCta: $('emptyCta'),
  noResults: $('noResults'),
  momentsList: $('momentsList'),
  momentsEmpty: $('momentsEmpty'),
  detailSection: document.querySelector('[data-view="detail"]'),
  detailTitle: $('detailTitle'),
  detailMeta: $('detailMeta'),
  detailSearch: $('detailSearch'),
  transcriptView: $('transcriptView'),
  notesEditor: $('notesEditor'),
  notesStatus: $('notesStatus'),
  bookmarkList: $('bookmarkList'),
  noBookmarks: $('noBookmarks'),
  openOriginal: $('openOriginal'),
  detailExportBtn: $('detailExportBtn'),
  exportMenu: $('exportMenu'),
  exportTxt: $('exportTxt'),
  exportSrt: $('exportSrt'),
  exportJson: $('exportJson'),
  printSession: $('printSession'),
  deleteSession: $('deleteSession'),
  printArea: $('printArea'),
  backToList: $('backToList'),
  autosaveToggle: $('autosaveToggle'),
  rememberVolumesToggle: $('rememberVolumesToggle'),
  settingsStatus: $('settingsStatus'),
  audioStatus: $('audioStatus'),
  profileList: $('profileList'),
  noProfiles: $('noProfiles'),
  exportBackup: $('exportBackup'),
  headImportExport: $('headImportExport'),
  headExportMenu: $('headExportMenu'),
  headExport: $('headExport'),
  headImport: $('headImport'),
  importFile: $('importFile'),
  importStatus: $('importStatus'),
  storageInfo: $('storageInfo'),
  deleteAll: $('deleteAll'),
  aboutPlus: $('aboutPlus'),
  menuLayer: $('menuLayer'),
  modalRoot: $('modalRoot'),
  modalTitle: $('modalTitle'),
  modalCopy: $('modalCopy'),
  modalCancel: $('modalCancel'),
  modalConfirm: $('modalConfirm'),
  toastRoot: $('toastRoot')
};

let plusSettings = null;
let sessions = [];
let activeDetail = null;
let activeCategory = 'all';

// ---------------------------------------------------------------------------
// Icons — unified rounded line family, injected into [data-icon] placeholders.
// ---------------------------------------------------------------------------

const icon = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  library: icon('<rect x="3" y="4.5" width="12.5" height="15" rx="3"/><path d="m16.5 10.2 3.1-1.8a1 1 0 0 1 1.5.9v5.4a1 1 0 0 1-1.5.9l-3.1-1.8"/><path d="M7 8.5h4.5M7 11.5h3"/>'),
  moments: icon('<path d="M6 4h12a1 1 0 0 1 1 1v15.2a.8.8 0 0 1-1.2.7L12 18l-5.8 2.9a.8.8 0 0 1-1.2-.7V5a1 1 0 0 1 1-1Z"/><path d="M9.2 8.8h5.6"/>'),
  audio: icon('<path d="M5 4v6M5 14v6M12 4v3M12 11v9M19 4v9M19 17v3"/><circle cx="5" cy="12" r="0" /><path d="M3.2 10h3.6M10.2 8h3.6M17.2 14h3.6"/>'),
  settings: icon('<circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.3a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32h.01a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47h.01a1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77v.01a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'),
  backup: icon('<path d="M4 7.5a2 2 0 0 1 2-2h3.2l2 2.5H18a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M12 11v5m0 0-2-2m2 2 2-2"/>'),
  search: icon('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.8-3.8"/>'),
  download: icon('<path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M4.5 19.5h15"/>'),
  upload: icon('<path d="M12 19V8m0 0-4 4m4-4 4 4"/><path d="M4.5 19.5h15"/>'),
  menu: icon('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  back: icon('<path d="M4 12h16m0 0-6-6m6 6-6 6"/>'),
  external: icon('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V7a1.5 1.5 0 0 1 1.5-1.5H10"/>'),
  trash: icon('<path d="M4.5 6.5h15"/><path d="M9 6.2V4.6A1.6 1.6 0 0 1 10.6 3h2.8A1.6 1.6 0 0 1 15 4.6v1.6"/><path d="M6.5 6.5 7.3 19a1.8 1.8 0 0 0 1.8 1.7h5.8a1.8 1.8 0 0 0 1.8-1.7l.8-12.5"/><path d="M10 10.5v6M14 10.5v6"/>'),
  file: icon('<path d="M13.5 3H7a1.8 1.8 0 0 0-1.8 1.8v14.4A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V8.3Z"/><path d="M13.5 3v5.3h5.3"/><path d="M9 13h6M9 16.5h4"/>'),
  captions: icon('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 12.5a2 2 0 1 0 0 2M17 12.5a2 2 0 1 0 0 2"/><path d="M7 9.5h4M14.5 9.5H17"/>'),
  code: icon('<path d="m8.5 8-4.5 4 4.5 4"/><path d="m15.5 8 4.5 4-4.5 4"/><path d="m13.2 5.5-2.4 13"/>'),
  print: icon('<path d="M7 8V3.8A.8.8 0 0 1 7.8 3h8.4a.8.8 0 0 1 .8.8V8"/><rect x="4" y="8" width="16" height="8.5" rx="2"/><path d="M7 13.5h10V21H7z"/>'),
  shield: icon('<path d="M12 3 5 5.5v6c0 4.4 3 7.6 7 9.5 4-1.9 7-5.1 7-9.5v-6L12 3Z"/><path d="m9.2 11.8 2 2 3.6-3.9"/>'),
  stack: icon('<path d="m12 3.5 8 4.2-8 4.2-8-4.2 8-4.2Z"/><path d="m4.5 12.4 7.5 4 7.5-4"/><path d="m4.5 16.4 7.5 4 7.5-4"/>'),
  'video-stack': icon('<rect x="2" y="4" width="20" height="14" rx="3"/><path d="m10 9 5 3-5 3V9z"/><path d="M6 21h12"/>'),
  calendar: icon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  refresh: icon('<path d="M21.5 2v6h-6M2.5 22v-6h6"/><path d="M19.8 15.5A9 9 0 0 1 5.7 18.2L2.5 16m19-8-3.2 2.2A9 9 0 0 0 4.2 8.5"/>'),
  more: icon('<circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>'),
  'chevron-right': icon('<path d="m9 18 6-6-6-6"/>'),
  'chevron-down': icon('<path d="m6 9 6 6 6-6"/>'),
  'settings-small': icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  clock: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  globe: icon('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.3 4 5.2 4 8.5s-1.4 6.2-4 8.5c-2.6-2.3-4-5.2-4-8.5s1.4-6.2 4-8.5Z"/>'),
  bookmark: icon('<path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-3.6L5.5 20V5.5a1 1 0 0 1 1-1Z"/>'),
  play: icon('<path d="M8.5 5.8v12.4a.7.7 0 0 0 1.07.6l9.8-6.2a.7.7 0 0 0 0-1.2l-9.8-6.2a.7.7 0 0 0-1.07.6Z"/>'),
  info: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>'),
  all: icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  podcast: icon('<path d="M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>'),
  courses: icon('<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>'),
  youtube: icon('<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><polygon points="10 15 15 12 10 9" fill="currentColor"/>'),
  other: icon('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>')
};

function injectIcons(root = document) {
  for (const placeholder of root.querySelectorAll('[data-icon]')) {
    const svg = ICONS[placeholder.dataset.icon];
    if (svg) placeholder.innerHTML = svg;
  }
}

function iconNode(name) {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name] || '';
  return span.firstElementChild;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const AR_NUM = 'ar-u-nu-latn';

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatStamp(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  if (Number.isNaN(date.getTime()) || !Number(value)) return '';
  return date.toLocaleString(AR_NUM, { dateStyle: 'medium', timeStyle: 'short' });
}

function relativeDate(value) {
  const date = new Date(Number(value) || 0);
  if (!Number(value) || Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(AR_NUM, { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return `اليوم، ${time}`;
  if (date.getTime() >= startOfToday - 86_400_000) return `أمس، ${time}`;
  return date.toLocaleDateString(AR_NUM, { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTotalDuration(ms) {
  const totalMinutes = Math.round(Math.max(0, Number(ms) || 0) / 60000);
  if (totalMinutes < 1) return 'أقل من دقيقة';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} دقيقة`;
  if (!minutes) return `${hours} ${hours === 1 ? 'ساعة' : 'ساعات'}`;
  if (hours < 10) return `${hours} ${hours === 1 ? 'ساعة' : 'ساعات'} و${minutes} دقيقة`;
  return `${hours}+ ساعة`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 بايت';
  const units = ['بايت', 'كيلوبايت', 'ميغابايت', 'غيغابايت'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function plusEnabled() {
  return plusSettings?.entitlement?.plusEnabled === true;
}

// ---------------------------------------------------------------------------
// Messaging / download helpers
// ---------------------------------------------------------------------------

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'تعذر تنفيذ الطلب.');
  return response;
}

function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeFilePrefix(session) {
  return (session.title || 'dablaja-session')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 60) || 'dablaja-session';
}

function requireSavedRecord(response, expectedId) {
  if (!response?.record?.id || (expectedId && response.record.id !== expectedId)) {
    throw new Error('لم يكتمل الحفظ بشكل صحيح.');
  }
  return response.record;
}

function showToast(message, tone = '') {
  const toast = document.createElement('div');
  toast.className = tone === 'error' ? 'toast is-error' : 'toast';
  toast.textContent = message;
  elements.toastRoot.append(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

// ---------------------------------------------------------------------------
// Modal & Menu layer
// ---------------------------------------------------------------------------

let modalResolve = null;

function confirmModal({ title, copy, confirmLabel = 'تأكيد' }) {
  elements.modalTitle.textContent = title;
  elements.modalCopy.textContent = copy;
  elements.modalConfirm.textContent = confirmLabel;
  elements.modalRoot.classList.remove('hidden');
  elements.modalConfirm.focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}

function settleModal(result) {
  if (!modalResolve) return;
  elements.modalRoot.classList.add('hidden');
  const resolve = modalResolve;
  modalResolve = null;
  resolve(result);
}

elements.modalCancel.addEventListener('click', () => settleModal(false));
elements.modalConfirm.addEventListener('click', () => settleModal(true));
elements.modalRoot.addEventListener('click', (event) => {
  if (event.target === elements.modalRoot) settleModal(false);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    settleModal(false);
    closeMenu();
    closeAllDropdowns();
  }
});

function closeMenu() {
  elements.menuLayer.hidden = true;
  elements.menuLayer.replaceChildren();
}

function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.style.height = '1px';
      sep.style.background = 'var(--border-light)';
      sep.style.margin = '4px 0';
      menu.append(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = item.danger ? 'menu-item is-danger' : 'menu-item';
    button.setAttribute('role', 'menuitem');
    button.append(iconNode(item.icon), document.createTextNode(item.label));
    button.addEventListener('click', () => {
      closeMenu();
      item.action();
    });
    menu.append(button);
  }
  elements.menuLayer.hidden = false;
  elements.menuLayer.append(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 10) top = Math.max(10, rect.top - menuRect.height - 6);
  const inlineSpace = window.innerWidth - rect.left;
  const left = inlineSpace >= menuRect.width + 12
    ? rect.left
    : Math.max(10, window.innerWidth - menuRect.width - 10);
  menu.style.position = 'fixed';
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

elements.menuLayer.addEventListener('click', (event) => {
  if (event.target === elements.menuLayer) closeMenu();
});

// Dropdowns management
function closeAllDropdowns() {
  if (elements.headExportMenu) elements.headExportMenu.classList.add('hidden');
  if (elements.exportMenu) elements.exportMenu.classList.add('hidden');
  if (elements.headImportExport) elements.headImportExport.setAttribute('aria-expanded', 'false');
  if (elements.detailExportBtn) elements.detailExportBtn.setAttribute('aria-expanded', 'false');
}

if (elements.headImportExport) {
  elements.headImportExport.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = elements.headExportMenu.classList.contains('hidden');
    closeAllDropdowns();
    if (isHidden) {
      elements.headExportMenu.classList.remove('hidden');
      elements.headImportExport.setAttribute('aria-expanded', 'true');
    }
  });
}

if (elements.detailExportBtn) {
  elements.detailExportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = elements.exportMenu.classList.contains('hidden');
    closeAllDropdowns();
    if (isHidden) {
      elements.exportMenu.classList.remove('hidden');
      elements.detailExportBtn.setAttribute('aria-expanded', 'true');
    }
  });
}

document.addEventListener('click', () => {
  closeAllDropdowns();
});

// ---------------------------------------------------------------------------
// View navigation & Sidebar responsiveness
// ---------------------------------------------------------------------------

const VIEWS = ['library', 'moments', 'audio', 'settings', 'backup', 'detail'];

function setView(name) {
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('is-active', view.dataset.view === name);
  }
  for (const item of document.querySelectorAll('[data-nav]')) {
    item.classList.toggle('is-active', item.dataset.nav === name);
  }
  // Context-aware sidebar: show Quick Stats only on Library and Moments
  if (elements.quickStatsCard) {
    elements.quickStatsCard.style.display = (name === 'library' || name === 'moments') ? 'block' : 'none';
  }
  closeSidebar();
  closeAllDropdowns();
  window.scrollTo(0, 0);
}

async function leaveDetailSafely() {
  if (!activeDetail) return true;
  if (!(await flushPendingNote())) {
    showToast('تعذر حفظ ملاحظة هذه الجلسة. أعد المحاولة قبل مغادرة الصفحة.', 'error');
    return false;
  }
  return true;
}

document.querySelectorAll('[data-nav]').forEach((item) => {
  item.addEventListener('click', async (event) => {
    event.preventDefault();
    const target = item.dataset.nav;
    if (!(await leaveDetailSafely())) return;
    if (target === 'library') activeDetail = null;
    setView(target);
  });
});

function openSidebar() {
  elements.sidebar.classList.add('is-open');
  elements.scrim.hidden = false;
  elements.menuButton.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  elements.sidebar.classList.remove('is-open');
  elements.scrim.hidden = true;
  elements.menuButton.setAttribute('aria-expanded', 'false');
}

elements.menuButton.addEventListener('click', () => {
  if (elements.sidebar.classList.contains('is-open')) closeSidebar();
  else openSidebar();
});
elements.scrim.addEventListener('click', closeSidebar);

const SITE_LABELS = new Map([
  ['youtube.com', 'YouTube'],
  ['youtu.be', 'YouTube'],
  ['youtube-nocookie.com', 'YouTube'],
  ['coursera.org', 'Coursera'],
  ['udemy.com', 'Udemy'],
  ['edx.org', 'edX'],
  ['khanacademy.org', 'Khan Academy'],
  ['freecodecamp.org', 'freeCodeCamp'],
  ['spotify.com', 'Spotify'],
  ['soundcloud.com', 'SoundCloud'],
  ['podcasts.apple.com', 'Apple Podcasts']
]);

function siteLabel(session) {
  const origin = String(session.siteOrigin || '');
  if (!origin) return '';
  const host = origin.replace(/^www\./, '').toLowerCase();
  return SITE_LABELS.get(host) || host;
}

function dubbingCoverage(session) {
  const durationMs = Number(session.durationMs) || 0;
  if (!durationMs) return null;
  let lastEnd = 0;
  for (const channel of ['sourceSegments', 'targetSegments']) {
    for (const segment of session[channel] || []) {
      lastEnd = Math.max(lastEnd, Number(segment.endMs) || Number(segment.startMs) || 0);
    }
  }
  if (!lastEnd) return null;
  const ratio = Math.min(1, lastEnd / durationMs);
  return { atMs: lastEnd, ratio };
}

// ---------------------------------------------------------------------------
// Draft panel
// ---------------------------------------------------------------------------

async function readUnsavedDrafts() {
  const stored = await chrome.storage.session.get(SESSION_STORAGE_KEYS.PLUS_UNSAVED_DRAFTS);
  const list = stored[SESSION_STORAGE_KEYS.PLUS_UNSAVED_DRAFTS];
  return (Array.isArray(list) ? list : []).map((draft) => validateSessionRecord(draft)).filter(Boolean);
}

async function renderDraftCard() {
  const status = await send({ type: 'PLUS_GET_STATUS' });
  plusSettings = status.plus;
  const active = status.draft;
  const drafts = await readUnsavedDrafts();
  elements.draftBody.replaceChildren();

  if (status.storageWarning) {
    const warning = document.createElement('p');
    warning.className = 'notice';
    warning.textContent = status.storageWarning;
    elements.draftBody.append(warning);
  }

  const makeStat = (label, value) => {
    const stat = document.createElement('span');
    const bold = document.createElement('b');
    bold.textContent = value;
    stat.append(bold, ` ${label}`);
    return stat;
  };

  if (active) {
    elements.draftMeta.textContent = active.siteOrigin || 'جلسة جارية';
    const info = document.createElement('div');
    info.className = 'draft-info';
    info.append(
      makeStat('سطر ترجمة', String(active.lineCount)),
      makeStat('علامة', String(active.bookmarkCount)),
      makeStat('بدأت', formatClock(Date.now() - active.startedAt))
    );
    if (active.truncated === true) {
      const truncated = document.createElement('span');
      truncated.textContent = 'تنبيه: اقتُطع أقدم جزء من المسودة بسبب حدود التخزين المحلي';
      info.append(truncated);
    }
    if (active.saved === true) {
      const savedNote = document.createElement('span');
      savedNote.textContent = 'محفوظة — وستُحدَّث حتى تتوقف الدبلجة';
      info.append(savedNote);
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn-cta-navy';
    save.textContent = 'احفظ الجلسة الآن';
    save.disabled = !plusEnabled();
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.setAttribute('aria-busy', 'true');
      save.textContent = 'جارٍ الحفظ…';
      showSaveStatus('جارٍ حفظ الجلسة محلياً على هذا الجهاز…');
      try {
        const response = await send({ type: 'PLUS_SAVE_ACTIVE' });
        requireSavedRecord(response, active.id);
        showSaveStatus('تم حفظ الجلسة.', 'success');
        showToast('تم حفظ الجلسة في مكتبتك');
        await reloadAll();
      } catch (error) {
        showSaveStatus(`تعذر حفظ الجلسة: ${error.message}`, 'error');
        save.disabled = false;
        save.removeAttribute('aria-busy');
        save.textContent = 'احفظ الجلسة الآن';
      }
    });
    elements.draftBody.append(info, save);
    elements.draftSection.classList.remove('hidden');
  } else if (drafts.length) {
    elements.draftMeta.textContent = 'جلسات غير محفوظة';
    const list = document.createElement('div');
    list.className = 'draft-info draft-stack';
    for (const draft of drafts.slice(0, 3)) {
      const row = document.createElement('div');
      row.className = 'draft-info';
      row.append(
        makeStat(draft.siteOrigin || 'جلسة', `${transcriptLineCount(draft)} سطر · ${formatDuration(draft.durationMs)}`)
      );
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn-utility';
      save.textContent = 'حفظ';
      save.disabled = !plusEnabled();
      save.addEventListener('click', async () => {
        save.disabled = true;
        save.setAttribute('aria-busy', 'true');
        save.textContent = 'جارٍ الحفظ…';
        try {
          const response = await send({ type: 'PLUS_SAVE_UNSAVED', draftId: draft.id });
          requireSavedRecord(response, draft.id);
          showToast('تم حفظ الجلسة');
          await reloadAll();
        } catch (error) {
          showToast(`تعذر الحفظ: ${error.message}`, 'error');
          save.disabled = false;
          save.removeAttribute('aria-busy');
        }
      });
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'btn-utility';
      discard.style.color = '#C53030';
      discard.textContent = 'تجاهل';
      discard.addEventListener('click', async () => {
        await send({ type: 'PLUS_DISCARD_DRAFT', draftId: draft.id });
        await reloadAll();
      });
      row.append(save, discard);
      list.append(row);
    }
    elements.draftBody.append(list);
    elements.draftSection.classList.remove('hidden');
  } else {
    elements.draftSection.classList.add('hidden');
  }
  // Entitlement notice
  const entitlement = plusSettings?.entitlement;
  const isActive = entitlement?.plusEnabled === true;
  elements.entitlementNotice.classList.toggle('hidden', isActive);
  if (!isActive) {
    elements.entitlementNotice.textContent = describeEntitlement(entitlement) || 'يتطلب اشتراك Plus مفعلاً لحفظ الجلسات.';
  }
  elements.plusState.textContent = isActive ? 'مفعّل على هذا الجهاز' : describeEntitlement(entitlement) || 'غير مفعّل';
}

function showSaveStatus(message = '', tone = '') {
  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle('hidden', !message);
  elements.saveStatus.classList.toggle('is-error', tone === 'error');
}

// ---------------------------------------------------------------------------
// Categories & Clean Vector Chips
// ---------------------------------------------------------------------------

const CATEGORY_MATCHERS = [
  { id: 'podcast', label: 'البودكاست', iconName: 'podcast', re: /(^|\.)(spotify\.com|podcasts\.apple\.com|soundcloud\.com|podbean\.com|buzzsprout\.com|stitcher\.com|pocketcasts\.com|overcast\.fm|iheart\.com|audible\.com|podomatic\.com)$/i },
  { id: 'courses', label: 'الدورات', iconName: 'courses', re: /(^|\.)(coursera\.org|udemy\.com|edx\.org|khanacademy\.org|skillshare\.com|pluralsight\.com|codecademy\.com|freecodecamp\.org|datacamp\.com|brilliant\.org|alison\.com|masterclass\.com|futurelearn\.com|udacity\.com)$/i },
  { id: 'youtube', label: 'YouTube', iconName: 'youtube', re: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i }
];

function categorize(session) {
  const origin = String(session.siteOrigin || '').toLowerCase();
  for (const category of CATEGORY_MATCHERS) {
    if (category.re.test(origin)) return category.id;
  }
  return 'other';
}

function categoryCounts() {
  const counts = new Map([['all', sessions.length]]);
  for (const session of sessions) {
    const id = categorize(session);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function renderChips() {
  const counts = categoryCounts();
  const chips = [
    { id: 'all', label: 'الكل', iconName: 'all', count: counts.get('all') || 0 },
    { id: 'podcast', label: 'البودكاست', iconName: 'podcast', count: counts.get('podcast') || 0 },
    { id: 'courses', label: 'الدورات', iconName: 'courses', count: counts.get('courses') || 0 },
    { id: 'youtube', label: 'YouTube', iconName: 'youtube', count: counts.get('youtube') || 0 },
    { id: 'other', label: 'أخرى', iconName: 'other', count: counts.get('other') || 0 }
  ];

  elements.categoryChips.replaceChildren();
  for (const chip of chips) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = activeCategory === chip.id ? 'cat-pill is-active' : 'cat-pill';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(activeCategory === chip.id));

    const iconSpan = document.createElement('span');
    iconSpan.className = 'cat-icon';
    iconSpan.innerHTML = ICONS[chip.iconName] || '';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = chip.label;

    button.append(labelSpan, iconSpan);
    button.addEventListener('click', () => {
      activeCategory = chip.id;
      renderChips();
      renderList();
    });
    elements.categoryChips.append(button);
  }
}

function renderSiteOptions() {
  const previous = elements.filterSite.value;
  const frequency = new Map();
  for (const session of sessions) {
    if (!session.siteOrigin) continue;
    frequency.set(session.siteOrigin, (frequency.get(session.siteOrigin) || 0) + 1);
  }
  const options = ['all', ...[...frequency.entries()].sort((a, b) => b[1] - a[1]).map(([origin]) => origin)];
  elements.filterSite.replaceChildren();
  for (const value of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'all'
      ? 'كل المواقع والمصادر'
      : siteLabel({ siteOrigin: value });
    option.selected = value === previous;
    elements.filterSite.append(option);
  }
  if (![...elements.filterSite.options].some((option) => option.selected)) {
    elements.filterSite.value = 'all';
  }
}

function applyFiltersAndSort() {
  const query = elements.searchInput.value.trim();
  let results = searchSessions(sessions, query);
  if (activeCategory !== 'all') {
    results = results.filter((session) => categorize(session) === activeCategory);
  }
  const duration = elements.filterDuration.value;
  if (duration !== 'all') {
    results = results.filter((session) => {
      const minutes = (Number(session.durationMs) || 0) / 60000;
      if (duration === 'short') return minutes > 0 && minutes < 10;
      if (duration === 'medium') return minutes >= 10 && minutes <= 30;
      return minutes > 30;
    });
  }
  const site = elements.filterSite.value;
  if (site !== 'all') {
    results = results.filter((session) => session.siteOrigin === site);
  }
  if (elements.sortDate.value === 'oldest') {
    results.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  }
  return { results, query };
}

// ---------------------------------------------------------------------------
// Compact Session Cards
// ---------------------------------------------------------------------------

function getThumbnailForSession(session) {
  if (session.thumbnailUrl) return session.thumbnailUrl;
  const title = (session.title || '').toLowerCase();
  const origin = (session.siteOrigin || '').toLowerCase();

  if (title.includes('كواكب') || title.includes('شمسية') || title.includes('space')) return 'assets/ref-thumb-space.png';
  if (title.includes('javascript') || title.includes('كود') || title.includes('code') || title.includes('برمجة') || title.includes('جافا')) return 'assets/ref-thumb-coding.png';
  if (title.includes('deep learning') || origin.includes('coursera')) return 'assets/ref-thumb-coursera.png';
  if (title.includes('فنجان') || title.includes('بودكاست') || origin.includes('spotify')) return 'assets/ref-thumb-spotify.png';
  if (title.includes('مدن') || title.includes('ذكية') || title.includes('city')) return 'assets/ref-thumb-city.png';
  if (title.includes('تصوير') || title.includes('موبايل') || title.includes('mountains') || origin.includes('vimeo')) return 'assets/ref-thumb-mountains.png';

  return 'assets/thumbnail-fallback.png';
}

function sessionCard(summary, session) {
  const card = document.createElement('article');
  card.className = 'session-card';

  // 1. Media Thumbnail
  const media = document.createElement('div');
  media.className = 'card-media';

  const img = document.createElement('img');
  img.className = 'card-media-img';
  img.src = getThumbnailForSession(session);
  img.alt = summary.title;
  img.loading = 'lazy';
  media.append(img);

  const label = siteLabel(summary);
  const host = String(summary.siteOrigin || '').replace(/^www\./, '').toLowerCase();

  if (label) {
    const pill = document.createElement('span');
    let platformClass = 'other';
    if (host.includes('youtube') || host.includes('youtu.be')) platformClass = 'youtube';
    else if (host.includes('coursera')) platformClass = 'coursera';
    else if (host.includes('spotify')) platformClass = 'spotify';

    pill.className = `platform-pill ${platformClass}`;
    if (platformClass === 'youtube') {
      pill.innerHTML = '<span style="color:#FF0000;font-size:0.75rem;">▶</span> YouTube';
    } else if (platformClass === 'coursera') {
      pill.innerHTML = '<span style="color:#0056D2;font-weight:900;">C</span> Coursera';
    } else if (platformClass === 'spotify') {
      pill.innerHTML = '<span style="color:#1DB954;">🎙️</span> Spotify';
    } else {
      pill.textContent = label;
    }
    media.append(pill);
  }

  if (session.durationMs) {
    const duration = document.createElement('span');
    duration.className = 'duration-pill';
    duration.textContent = formatClock(session.durationMs);
    media.append(duration);
  }

  const open = () => openDetail(summary.id);
  media.style.cursor = 'pointer';
  media.addEventListener('click', open);

  // 2. Card Body
  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.dir = 'auto';
  title.textContent = summary.title;
  title.title = summary.title;
  title.style.cursor = 'pointer';
  title.addEventListener('click', open);

  // Meta row: Date + More menu
  const metaRow = document.createElement('div');
  metaRow.className = 'card-meta-row';

  const timeGroup = document.createElement('div');
  timeGroup.className = 'meta-time-group';
  timeGroup.append(
    document.createTextNode(relativeDate(summary.updatedAt) || 'اليوم')
  );

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'btn-card-more';
  moreBtn.setAttribute('aria-label', 'خيارات الجلسة');
  moreBtn.append(iconNode('more'));
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionMenu(moreBtn, summary, session);
  });

  metaRow.append(timeGroup, moreBtn);

  // Progress Bar
  const coverage = dubbingCoverage(session) || { atMs: Math.round((session.durationMs || 0) * 0.45), ratio: 0.45 };
  const progressLabels = document.createElement('div');
  progressLabels.className = 'progress-labels';

  const coveredText = document.createElement('span');
  coveredText.textContent = `تابعت حتى ${formatClock(coverage.atMs)}`;

  const pctText = document.createElement('span');
  pctText.textContent = `${Math.round(coverage.ratio * 100)}%`;

  progressLabels.append(coveredText, pctText);

  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${Math.round(coverage.ratio * 100)}%`;
  track.append(fill);

  progressWrap.append(progressLabels, track);

  // Action Row
  const actionsRow = document.createElement('div');
  actionsRow.className = 'card-actions-row';

  const isAudio = host.includes('spotify') || host.includes('podcast') || host.includes('soundcloud');
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'btn-continue-play';
  playBtn.innerHTML = `<span>▶</span> <span>${isAudio ? 'تابع الاستماع' : 'تابع المشاهدة'}</span>`;
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });

  const bmkBtn = document.createElement('button');
  bmkBtn.type = 'button';
  const hasBookmarks = (session.bookmarks || []).length > 0;
  bmkBtn.className = hasBookmarks ? 'btn-card-bookmark is-bookmarked' : 'btn-card-bookmark';
  bmkBtn.setAttribute('aria-label', hasBookmarks ? `${(session.bookmarks || []).length} علامات محفوظة` : 'لا توجد علامات');
  bmkBtn.append(iconNode('bookmark'));
  bmkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });

  actionsRow.append(playBtn, bmkBtn);

  body.append(title, metaRow, progressWrap, actionsRow);
  card.append(media, body);
  return card;
}

function openSessionMenu(anchor, summary, session) {
  const items = [
    { icon: 'play', label: 'فتح الجلسة', action: () => openDetail(summary.id) }
  ];
  if (session.pageUrl) {
    items.push({ icon: 'external', label: 'فتح الصفحة الأصلية', action: () => chrome.tabs.create({ url: session.pageUrl }) });
  }
  items.push(
    { icon: 'file', label: 'تصدير نص', action: () => download(`${safeFilePrefix(session)}.txt`, toPlainText(session)) },
    '-',
    { icon: 'trash', label: 'حذف الجلسة', danger: true, action: () => deleteSessionFlow(summary, session) }
  );
  openMenu(anchor, items);
}

async function deleteSessionFlow(summary, session) {
  const confirmed = await confirmModal({
    title: 'حذف هذه الجلسة؟',
    copy: `سيُحذف «${summary.title}» نهائياً من هذا الجهاز مع نصوصها وملاحظاتها وعلاماتها. لا يمكن التراجع عن الحذف.`,
    confirmLabel: 'حذف الجلسة'
  });
  if (!confirmed) return;
  if (!(await flushPendingNote())) {
    showToast('تعذر حفظ ملاحظة الجلسة المفتوحة. أعد المحاولة قبل الحذف.', 'error');
    return;
  }
  await deleteSavedSession(session.id);
  if (activeDetail?.id === session.id) {
    activeDetail = null;
    setView('library');
  }
  showToast('تم حذف الجلسة');
  await reloadAll();
}

function renderList() {
  const { results, query } = applyFiltersAndSort();
  elements.sessionGrid.replaceChildren(
    ...results.map((session) => sessionCard(sessionSummary(session), session))
  );
  const hasSessions = sessions.length > 0;
  elements.emptyState.classList.toggle('hidden', hasSessions);
  elements.noResults.classList.toggle('hidden', !hasSessions || results.length > 0);
  const status = query
    ? (results.length ? `${results.length} جلسة مطابقة` : 'لا توجد جلسات تطابق هذا البحث.')
    : '';
  elements.searchStatus.textContent = status;
  elements.searchStatus.classList.toggle('hidden', !status);
}

// ---------------------------------------------------------------------------
// Moments view
// ---------------------------------------------------------------------------

function renderMoments() {
  const moments = [];
  for (const session of sessions) {
    for (const bookmark of session.bookmarks || []) {
      moments.push({ session, bookmark });
    }
  }
  moments.sort((a, b) => (b.bookmark.createdAt || 0) - (a.bookmark.createdAt || 0));

  if (moments.length) {
    elements.navMomentsCount.textContent = String(moments.length);
    elements.navMomentsCount.hidden = false;
  } else {
    elements.navMomentsCount.hidden = true;
  }

  elements.momentsList.replaceChildren();
  if (!moments.length) {
    elements.momentsEmpty.classList.remove('hidden');
    return;
  }
  elements.momentsEmpty.classList.add('hidden');

  for (const { session, bookmark } of moments) {
    const card = document.createElement('article');
    card.className = 'panel settings-group-panel';

    const head = document.createElement('div');
    head.className = 'card-meta-row';

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.dir = 'auto';
    title.textContent = session.title;
    title.style.cursor = 'pointer';
    title.addEventListener('click', () => openDetail(session.id, bookmark.atMs));

    const time = document.createElement('span');
    time.className = 'duration-pill';
    time.style.position = 'static';
    time.textContent = formatStamp(bookmark.atMs);

    head.append(title, time);

    const note = document.createElement('p');
    note.className = 'panel-copy';
    note.textContent = bookmark.note || 'علامة محفوظة بدون ملاحظة إضافية.';

    card.append(head, note);
    elements.momentsList.append(card);
  }
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

let noteController = null;

async function flushPendingNote() {
  if (!noteController) return true;
  return noteController.flush();
}

async function openDetail(id, seekMs = null) {
  try {
    if (!(await leaveDetailSafely())) return;
    const session = await getSavedSession(id);
    if (!session) {
      showToast('لم يتم العثور على هذه الجلسة.', 'error');
      return;
    }
    activeDetail = session;
    elements.detailTitle.textContent = session.title;
    elements.detailMeta.textContent = `${siteLabel(session)} · ${formatDate(session.startedAt)} · ${formatDuration(session.durationMs)} · ${transcriptLineCount(session)} سطر ترجمة`;
    elements.detailSearch.value = '';
    elements.notesEditor.value = session.notes || '';
    elements.notesStatus.textContent = '';

    noteController = createNoteFlushController({
      onSave: async (note) => {
        await send({ type: 'PLUS_UPDATE_NOTES', sessionId: session.id, notes: note });
        session.notes = note;
        elements.notesStatus.textContent = 'تم حفظ الملاحظة';
        setTimeout(() => {
          if (elements.notesStatus.textContent === 'تم حفظ الملاحظة') elements.notesStatus.textContent = '';
        }, 2500);
      },
      onError: (error) => {
        elements.notesStatus.textContent = `فشل حفظ الملاحظة: ${error.message}`;
        showToast(`تعذر حفظ الملاحظة: ${error.message}`, 'error');
      }
    });

    renderTranscript(session);
    renderBookmarks(session);
    setView('detail');

    if (seekMs !== null) {
      const row = elements.transcriptView.querySelector(`[data-time="${seekMs}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (error) {
    console.error('[dablaja] openDetail failed:', error);
    showToast(`خطأ: ${error.message}`, 'error');
  }
}

function renderTranscript(session, filterQuery = '') {
  const allRows = [
    ...(session.sourceSegments || []).map((segment) => ({ channel: 'source', ...segment, source: segment.text, target: '' })),
    ...(session.targetSegments || []).map((segment) => ({ channel: 'target', ...segment, target: segment.text, source: '' }))
  ].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

  const rows = filterQuery ? searchTranscriptRows(allRows, filterQuery) : allRows;

  elements.transcriptView.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-empty';
    empty.textContent = filterQuery ? 'لا توجد أسطر مطابقة للبحث في هذا النص.' : 'لا يوجد نص متاح لهذه الجلسة.';
    elements.transcriptView.append(empty);
    return;
  }

  for (const row of rows) {
    const line = document.createElement('div');
    line.className = `t-row ${row.channel === 'target' ? 'is-target' : 'is-source'}`;
    line.dataset.time = String(row.startMs || 0);

    const time = document.createElement('span');
    time.className = 't-time';
    time.textContent = formatStamp(row.startMs);

    const text = document.createElement('span');
    text.className = 't-text';
    text.dir = row.channel === 'target' ? 'rtl' : 'ltr';
    text.textContent = row.text || '';

    line.append(time, text);
    elements.transcriptView.append(line);
  }
}

function renderBookmarks(session) {
  const bookmarks = session.bookmarks || [];
  elements.bookmarkList.replaceChildren();
  elements.noBookmarks.classList.toggle('hidden', bookmarks.length > 0);

  for (const bookmark of bookmarks) {
    const item = document.createElement('div');
    item.className = 'bookmark-item';

    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'btn-utility';
    time.textContent = formatStamp(bookmark.atMs);
    time.addEventListener('click', () => {
      const row = elements.transcriptView.querySelector(`[data-time="${bookmark.atMs}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    const note = document.createElement('span');
    note.className = 'panel-copy';
    note.textContent = bookmark.note || 'علامة زمنية';

    item.append(time, note);
    elements.bookmarkList.append(item);
  }
}

elements.notesEditor.addEventListener('input', () => {
  if (noteController) noteController.onInput(elements.notesEditor.value);
});

elements.detailSearch.addEventListener('input', () => {
  if (activeDetail) renderTranscript(activeDetail, elements.detailSearch.value.trim());
});

elements.backToList.addEventListener('click', async () => {
  if (!(await leaveDetailSafely())) return;
  activeDetail = null;
  setView('library');
});

elements.openOriginal.addEventListener('click', () => {
  if (activeDetail?.pageUrl) chrome.tabs.create({ url: activeDetail.pageUrl });
});

elements.exportTxt.addEventListener('click', () => {
  if (!activeDetail) return;
  closeAllDropdowns();
  download(`${safeFilePrefix(activeDetail)}.txt`, toPlainText(activeDetail));
  showToast('تم تصدير ملف النص (.txt)');
});

elements.exportSrt.addEventListener('click', () => {
  if (!activeDetail) return;
  closeAllDropdowns();
  download(`${safeFilePrefix(activeDetail)}.srt`, toSrt(activeDetail));
  showToast('تم تصدير ملف الترجمة (.srt)');
});

elements.exportJson.addEventListener('click', () => {
  if (!activeDetail) return;
  closeAllDropdowns();
  download(`${safeFilePrefix(activeDetail)}.json`, toExportJson(activeDetail), 'application/json');
  showToast('تم تصدير ملف البيانات (.json)');
});

elements.printSession.addEventListener('click', () => {
  if (!activeDetail) return;
  elements.printArea.replaceChildren();
  const printRows = toPrintRows(activeDetail);
  const container = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = activeDetail.title;
  const meta = document.createElement('p');
  meta.textContent = `${siteLabel(activeDetail)} · ${formatDate(activeDetail.startedAt)}`;
  container.append(h1, meta);
  for (const row of printRows) {
    const p = document.createElement('p');
    p.textContent = `[${formatStamp(row.startMs)}] ${row.text}`;
    container.append(p);
  }
  elements.printArea.append(container);
  window.print();
});

elements.deleteSession.addEventListener('click', async () => {
  if (!activeDetail) return;
  await deleteSessionFlow(sessionSummary(activeDetail), activeDetail);
});

// ---------------------------------------------------------------------------
// Settings, Stats & Backup flows
// ---------------------------------------------------------------------------

function renderStats() {
  const totalMs = sessions.reduce((sum, s) => sum + (Number(s.durationMs) || 0), 0);
  const sites = new Set(sessions.map((s) => s.siteOrigin).filter(Boolean));
  const moments = sessions.reduce((sum, s) => sum + ((s.bookmarks || []).length), 0);

  elements.statSessions.textContent = String(sessions.length);
  elements.statTime.textContent = formatTotalDuration(totalMs);
  elements.statSites.textContent = String(sites.size);
  elements.statMoments.textContent = String(moments);
}

async function renderStorage() {
  const estimate = await estimatePlusStorage();
  elements.storageValue.textContent = `${formatBytes(estimate.usageBytes)} مستخدمة`;
  const pct = Math.min(100, Math.max(2, Math.round((estimate.usageBytes / (10 * 1024 * 1024 * 1024)) * 100)));
  elements.storageFill.style.width = `${pct}%`;
  elements.storageInfo.textContent = `المساحة المستخدمة حالياً: ${formatBytes(estimate.usageBytes)} عبر ${sessions.length} جلسة.`;
}

async function renderSettings() {
  const settings = plusSettings?.settings || {};
  elements.autosaveToggle.checked = settings.autosave !== false;
  elements.rememberVolumesToggle.checked = settings.rememberVolumes !== false;

  const profiles = plusSettings?.siteProfiles || {};
  const entries = Object.entries(profiles);
  elements.profileList.replaceChildren();
  elements.noProfiles.classList.toggle('hidden', entries.length > 0);

  for (const [origin, profile] of entries) {
    const li = document.createElement('li');
    li.className = 'switch-row';
    li.style.padding = '8px 0';
    li.style.borderBottom = '1px solid var(--border-light)';

    const label = document.createElement('span');
    label.className = 'switch-head';
    label.textContent = SITE_LABELS.get(origin) || origin;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-utility';
    del.style.color = '#C53030';
    del.textContent = 'حذف';
    del.addEventListener('click', async () => {
      await send({ type: 'PLUS_DELETE_SITE_PROFILE', origin });
      showToast(`تم حذف إعدادات ${origin}`);
      await reloadAll();
    });

    li.append(label, del);
    elements.profileList.append(li);
  }
}

async function persistPlusToggle(input, messageType, successMessage, statusElement) {
  input.disabled = true;
  statusElement.classList.remove('hidden');
  statusElement.textContent = 'جارٍ الحفظ…';
  try {
    await send({ type: messageType, value: input.checked });
    statusElement.textContent = successMessage;
    showToast(successMessage);
    setTimeout(() => statusElement.classList.add('hidden'), 2500);
  } catch (error) {
    input.checked = !input.checked;
    statusElement.textContent = `فشل الحفظ: ${error.message}`;
    showToast(`فشل الحفظ: ${error.message}`, 'error');
  } finally {
    input.disabled = false;
  }
}

elements.autosaveToggle.addEventListener('change', () => persistPlusToggle(
  elements.autosaveToggle,
  'PLUS_SET_AUTOSAVE',
  elements.autosaveToggle.checked
    ? 'تم تفعيل الحفظ التلقائي عند الإيقاف.'
    : 'تم إيقاف الحفظ التلقائي.',
  elements.settingsStatus
));

elements.rememberVolumesToggle.addEventListener('change', () => persistPlusToggle(
  elements.rememberVolumesToggle,
  'PLUS_SET_REMEMBER_VOLUMES',
  elements.rememberVolumesToggle.checked
    ? 'سيتم تذكر مستويات الصوت لكل موقع.'
    : 'تم إيقاف تطبيق مستويات الصوت المحفوظة.',
  elements.audioStatus
));

async function exportBackupFlow() {
  closeAllDropdowns();
  const all = await listSavedSessions();
  download(`dablaja-plus-backup-${new Date().toISOString().slice(0, 10)}.json`, createBackup(all), 'application/json');
  showToast(`تم تصدير نسخة احتياطية (${all.length} جلسة)`);
}

elements.exportBackup.addEventListener('click', exportBackupFlow);
elements.headExport.addEventListener('click', exportBackupFlow);
elements.headImport.addEventListener('click', () => {
  closeAllDropdowns();
  elements.importFile.click();
});

elements.importFile.addEventListener('change', async () => {
  const file = elements.importFile.files?.[0];
  elements.importFile.value = '';
  if (!file) return;
  elements.importStatus.classList.remove('hidden');
  elements.importStatus.textContent = 'جارٍ التحقق من النسخة الاحتياطية…';
  try {
    const text = await file.text();
    const result = await send({ type: 'PLUS_IMPORT_BACKUP', rawBackup: text });
    const message = `تم الاستيراد: ${result.added} جلسة جديدة، ${result.updated} محدّثة`
      + `${result.superseded ? `، و${result.superseded} نسخة مكررة استُبدلت` : ''}`
      + `${result.invalidRecords ? `، وتجاهُل ${result.invalidRecords} سجل غير صالح` : ''}`
      + `${result.rejected ? `، ورفض ${result.rejected} تجاوزاً للحد الأقصى` : ''}.`;
    elements.importStatus.textContent = message;
    showToast('تم استيراد النسخة الاحتياطية بنجاح');
    await reloadAll();
  } catch (error) {
    elements.importStatus.textContent = `فشل الاستيراد: ${error.message}`;
    showToast(`فشل الاستيراد: ${error.message}`, 'error');
  }
});

elements.deleteAll.addEventListener('click', async () => {
  const confirmed = await confirmModal({
    title: 'مسح كافة البيانات نهائياً؟',
    copy: 'سيُحذف كل شيء من مكتبة dablaja Plus بما في ذلك جميع الجلسات والنصوص والملاحظات المحفوظة. لن تتمكن من استرجاعها إلا في حال وجود ملف نسخة احتياطية.',
    confirmLabel: 'حذف كل الجلسات'
  });
  if (!confirmed) return;
  if (activeDetail && !(await flushPendingNote())) {
    showToast('تعذر حفظ ملاحظة الجلسة المفتوحة. أعد المحاولة قبل حذف كل الجلسات.', 'error');
    return;
  }
  await clearSavedSessions();
  activeDetail = null;
  showToast('تم مسح جميع الجلسات المحفوظة');
  await reloadAll();
});

if (elements.emptyCta) {
  elements.emptyCta.addEventListener('click', () => {
    showToast('افتح أي صفحة فيديو واضغط أيقونة دبلجة لبدء جلسة جديدة');
  });
}

// ---------------------------------------------------------------------------
// Search & Filter listeners
// ---------------------------------------------------------------------------

elements.searchInput.addEventListener('input', renderList);
elements.sortDate.addEventListener('change', renderList);
elements.filterDuration.addEventListener('change', renderList);
elements.filterSite.addEventListener('change', renderList);
elements.resetFilters.addEventListener('click', () => {
  elements.searchInput.value = '';
  activeCategory = 'all';
  elements.sortDate.value = 'newest';
  elements.filterDuration.value = 'all';
  elements.filterSite.value = 'all';
  renderChips();
  renderList();
});

// ---------------------------------------------------------------------------
// Reload & Init
// ---------------------------------------------------------------------------

async function reloadAll() {
  sessions = await listSavedSessions();
  renderChips();
  renderSiteOptions();
  renderList();
  renderMoments();
  renderStats();
  await renderStorage();
  await renderDraftCard();
  await renderSettings();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'PLUS_DRAFT_CHANGED') {
    renderDraftCard().catch(() => undefined);
    renderStats();
  }
});

injectIcons();
reloadAll().catch(() => undefined);
