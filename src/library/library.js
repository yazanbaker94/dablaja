import { SESSION_STORAGE_KEYS } from '../shared/constants.js';
import { RECOVERY_CODE_PATTERN } from '../shared/plus-entitlement.js';
import { transcriptLineCount, validateSessionRecord } from '../shared/plus-session.js';
import { createNoteFlushController } from '../shared/note-flush.js';
import { searchSessions, searchTranscriptRows, sessionSummary } from '../shared/plus-search.js';
import { toExportJson, toPlainText, toPrintRows, toSrt } from '../shared/plus-export.js';
import { createBackup } from '../shared/plus-backup.js';
import { createRotationController } from '../shared/rotation-controller.js';
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
  topPlusBadge: $('topPlusBadge'),
  navMomentsCount: $('navMomentsCount'),
  quickStatsCard: $('quickStatsCard'),
  statSessions: $('statSessions'),
  statTime: $('statTime'),
  statSites: $('statSites'),
  statMoments: $('statMoments'),
  storageCard: $('storageCard'),
  storageValue: $('storageValue'),
  storageFill: $('storageFill'),
  entitlementNotice: $('lockedNotice'),
  freeTierUpgradeBanner: $('freeTierUpgradeBanner'),
  upgradeTopBtn: $('upgradeTopBtn'),
  activateTopBtn: $('activateTopBtn'),
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
  autoDuckingToggle: $('autoDuckingToggle'),
  rememberVolumesToggle: $('rememberVolumesToggle'),
  analyticsToggle: $('analyticsToggle'),
  localSavingToggle: $('localSavingToggle'),
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
  aboutPlusTitle: $('aboutPlusTitle'),
  aboutPlusTag: $('aboutPlusTag'),
  plusUpgradeBlock: $('plusUpgradeBlock'),
  libUpgradeBtn: $('libUpgradeBtn'),
  openActivationBtn: $('openActivationBtn'),
  activationModal: $('activationModal'),
  modalUpgradeCheckoutBtn: $('modalUpgradeCheckoutBtn'),
  activationInput: $('activationInput'),
  activationStatus: $('activationStatus'),
  activationCancel: $('activationCancel'),
  activationSubmit: $('activationSubmit'),
  menuLayer: $('menuLayer'),
  modalRoot: $('modalRoot'),
  modalTitle: $('modalTitle'),
  modalCopy: $('modalCopy'),
  modalCancel: $('modalCancel'),
  modalConfirm: $('modalConfirm'),
  toastRoot: $('toastRoot'),
  plusActiveActions: $('plusActiveActions'),
  rotateRecoveryBtn: $('rotateRecoveryBtn'),
  rotateRecoveryModal: $('rotateRecoveryModal'),
  rotateRecoveryTitle: $('rotateRecoveryTitle'),
  rotateConfirmStep: $('rotateConfirmStep'),
  rotateResultStep: $('rotateResultStep'),
  rotateConfirmBtn: $('rotateConfirmBtn'),
  rotateCancelBtn: $('rotateCancelBtn'),
  rotateResultCode: $('rotateResultCode'),
  rotateCopyBtn: $('rotateCopyBtn'),
  rotateCloseBtn: $('rotateCloseBtn'),
  rotateStatus: $('rotateStatus')
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

async function openPageUrl(url, failureMessage = 'تعذر فتح الصفحة. حاول مجدداً.') {
  try {
    await chrome.tabs.create({ url });
    return true;
  } catch (error) {
    showToast(error?.message || failureMessage, 'error');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Modal & Menu layer
// ---------------------------------------------------------------------------

let modalResolve = null;
let modalReturnFocus = null;
let activationModalReturnFocus = null;
let activationPending = false;

function focusableModalControls(root) {
  if (!root) return [];
  return [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.closest('.hidden'));
}

function trapModalFocus(root, event) {
  if (!root || event.key !== 'Tab' || root.classList.contains('hidden')) return;
  const controls = focusableModalControls(root);
  if (controls.length === 0) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function confirmModal({ title, copy, confirmLabel = 'تأكيد' }) {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}

elements.modalCancel.addEventListener('click', () => settleModal(false));
elements.modalConfirm.addEventListener('click', () => settleModal(true));
elements.modalRoot.addEventListener('click', (event) => {
  if (event.target === elements.modalRoot) settleModal(false);
});
window.addEventListener('keydown', (event) => {
  trapModalFocus(elements.modalRoot, event);
  trapModalFocus(elements.activationModal, event);
  if (event.key === 'Escape') {
    if (!elements.modalRoot.classList.contains('hidden')) settleModal(false);
    else if (!elements.activationModal?.classList.contains('hidden')) closeActivationModal();
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
    button.addEventListener('click', async () => {
      closeMenu();
      try {
        await item.action();
      } catch (error) {
        showToast(error?.message || 'تعذر تنفيذ الطلب. حاول مجدداً.', 'error');
      }
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
  let drafts = await readUnsavedDrafts();
  elements.draftBody.replaceChildren();
  elements.draftMeta.textContent = '';
  showSaveStatus('', '');

  if (!drafts.length) {
    elements.draftSection.classList.add('hidden');
  } else {
    elements.draftSection.classList.remove('hidden');
    const container = document.createElement('div');
    container.className = 'draft-stack';
    for (const draft of drafts) {
      const row = document.createElement('div');
      row.className = 'draft-info';
      const info = document.createElement('div');
      info.style.flex = '1';
      info.style.display = 'flex';
      info.style.flexDirection = 'column';
      const title = document.createElement('strong');
      title.textContent = draft.title || 'جلسة دبلجة';
      title.dir = 'auto';
      const meta = document.createElement('span');
      meta.style.fontSize = '0.82rem';
      meta.style.color = '#64748b';
      meta.textContent = `${formatDuration(draft.durationMs || 0)} · ${transcriptLineCount(draft)} سطر`;
      info.append(title, meta);
      const actions = document.createElement('div');
      actions.className = 'draft-actions-wrap';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'draft-save-btn';
      saveBtn.textContent = 'حفظ';
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        showSaveStatus('جارٍ الحفظ…', '');
        try {
          const res = await send({ type: 'PLUS_SAVE_UNSAVED', draftId: draft.id });
          if (res?.saved) {
            showSaveStatus('تم الحفظ', '');
            showToast('تم حفظ الجلسة');
            await reloadAll();
          } else if (res?.ok) {
            showSaveStatus('تم الحفظ', '');
            showToast('تم حفظ الجلسة');
            await reloadAll();
          }
        } catch {
          showSaveStatus('تعذر حفظ الجلسة. حاول مجدداً.', 'error');
          showToast('تعذر الحفظ — بقيت نسخة الاسترجاع', 'error');
        } finally {
          saveBtn.disabled = false;
          await renderDraftCard().catch(() => undefined);
        }
      });
      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'draft-discard-btn';
      discardBtn.textContent = 'تجاهل';
      discardBtn.addEventListener('click', async () => {
        const confirmed = await confirmModal({
          title: 'تجاهل المسودة؟',
          copy: 'سيتم حذف هذه المسودة غير المحفوظة نهائياً.',
          confirmLabel: 'تجاهل'
        });
        if (!confirmed) return;
        discardBtn.disabled = true;
        try {
          await send({ type: 'PLUS_DISCARD_DRAFT', draftId: draft.id });
          showToast('تم تجاهل المسودة');
          await reloadAll();
        } catch {
          showSaveStatus('تعذر تجاهل المسودة. حاول مجدداً.', 'error');
        } finally {
          discardBtn.disabled = false;
        }
      });
      actions.append(saveBtn, discardBtn);
      row.append(info, actions);
      container.append(row);
    }
    elements.draftBody.append(container);
    elements.draftMeta.textContent = `${drafts.length} مسودة بانتظار الحفظ`;
  }

  // Entitlement & Free Tier Upgrade Banner
  const entitlement = plusSettings?.entitlement;
  const isActive = entitlement?.plusEnabled === true;

  if (elements.freeTierUpgradeBanner) {
    elements.freeTierUpgradeBanner.classList.toggle('hidden', isActive);
  }

  const licenseProblem = entitlement?.state === 'revoked'
    ? 'تم إلغاء ترخيص Plus على هذا الجهاز. افتح «خلاصة الإعدادات» لتفعيل ترخيص صالح أو التواصل مع الدعم.'
    : entitlement?.state === 'expired'
      ? 'انتهت صلاحية التحقق المحلي من Plus. اتصل بالإنترنت وافتح «خلاصة الإعدادات» لتجديد التحقق.'
      : '';
  elements.entitlementNotice.textContent = licenseProblem;
  elements.entitlementNotice.classList.toggle('hidden', !licenseProblem);
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
  updateResetVisibility();
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
  // One clearly decorative bundled fallback. Never infer or fabricate a
  // thumbnail from the saved title/site, and never contact a remote image host.
  void session;
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
  img.onerror = () => {
    img.onerror = null;
    img.src = 'assets/thumbnail-fallback.png';
  };
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

  const open = () => {
    openDetail(summary.id);
  };

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
  const progressWrap = document.createElement('div');
  progressWrap.className = 'card-progress-wrap';

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
    if (session.pageUrl) {
      let targetUrl = session.pageUrl;
      const atSeconds = Math.floor((coverage.atMs || 0) / 1000);
      if (atSeconds > 5 && targetUrl.includes('youtube.com') && !targetUrl.includes('&t=') && !targetUrl.includes('?t=')) {
        targetUrl += `${targetUrl.includes('?') ? '&' : '?'}t=${atSeconds}s`;
      }
      void openPageUrl(targetUrl, 'تعذر فتح الفيديو الأصلي. حاول مجدداً.');
    } else {
      open();
    }
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
    items.push({ icon: 'external', label: 'فتح الصفحة الأصلية', action: () => openPageUrl(session.pageUrl, 'تعذر فتح الصفحة الأصلية.') });
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

async function renderMoments() {
  const moments = [];
  for (const session of sessions) {
    for (const bookmark of session.bookmarks || []) {
      moments.push({ session, bookmark, isDraft: false });
    }
  }
  try {
    const unsaved = await readUnsavedDrafts();
    for (const draft of unsaved) {
      for (const bookmark of draft.bookmarks || []) {
        moments.push({ session: draft, bookmark, isDraft: true });
      }
    }
  } catch {}

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

  moments.forEach(({ session, bookmark, isDraft }) => {
    const card = document.createElement('article');
    card.className = 'moment-card';

    const head = document.createElement('div');
    head.className = 'moment-meta-head';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'moment-title-group';

    const title = document.createElement('h3');
    title.className = 'moment-title';
    title.dir = 'auto';
    title.textContent = session.title || 'جلسة دبلجة';
    title.title = session.title || 'جلسة دبلجة';
    title.style.cursor = 'pointer';
    title.addEventListener('click', () => {
      openDetail(session.id, bookmark.atMs);
    });

    const origin = siteLabel(session);
    if (origin) {
      const siteBadge = document.createElement('span');
      siteBadge.className = 'moment-site-pill';
      siteBadge.textContent = origin;
      titleGroup.append(siteBadge);
    }
    titleGroup.append(title);

    const timePill = document.createElement('span');
    timePill.className = 'moment-time-pill';
    timePill.textContent = formatStamp(bookmark.atMs);

    head.append(titleGroup, timePill);

    // Look for quote from transcript if note is empty
    let noteText = bookmark.note;
    if (!noteText && (session.sourceSegments?.length || session.targetSegments?.length)) {
      const all = [
        ...(session.targetSegments || []).map((s) => ({ ...s, isTarget: true })),
        ...(session.sourceSegments || []).map((s) => ({ ...s, isTarget: false }))
      ];
      let closest = all[0];
      let minD = Math.abs((closest?.startMs || 0) - bookmark.atMs);
      for (const s of all) {
        const d = Math.abs((s.startMs || 0) - bookmark.atMs);
        if (d < minD) {
          minD = d;
          closest = s;
        }
      }
      if (closest && closest.text) {
        noteText = closest.text;
      }
    }

    const note = document.createElement('p');
    note.className = 'moment-quote-box';
    note.dir = 'auto';
    note.textContent = noteText || 'علامة محفوظة أثناء تشغيل الدبلجة.';

    // Moment Actions Row
    const actions = document.createElement('div');
    actions.className = 'moment-actions-row';

    {
      // 1. Play Video at Timestamp
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn-continue-play';
      playBtn.style.padding = '7px 15px';
      playBtn.style.fontSize = '12px';
      playBtn.innerHTML = `<span>▶</span> <span>تشغيل عند ${formatStamp(bookmark.atMs)}</span>`;
      playBtn.addEventListener('click', () => {
        if (session.pageUrl) {
          let targetUrl = session.pageUrl;
          const atSeconds = Math.floor((bookmark.atMs || 0) / 1000);
          if (targetUrl.includes('youtube.com') && !targetUrl.includes('&t=') && !targetUrl.includes('?t=')) {
            targetUrl += `${targetUrl.includes('?') ? '&' : '?'}t=${atSeconds}s`;
          }
          void openPageUrl(targetUrl, 'تعذر فتح الفيديو عند العلامة المحددة.');
        } else {
          openDetail(session.id, bookmark.atMs);
        }
      });

      // 2. View Transcript & Translation
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'btn-ghost-s';
      viewBtn.style.padding = '7px 14px';
      viewBtn.innerHTML = `<span>📄</span> <span>عرض النص والترجمة</span>`;
      viewBtn.addEventListener('click', () => openDetail(session.id, bookmark.atMs));

      // 3. Delete Bookmark (only for saved sessions)
      if (!isDraft) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-ghost-danger-s';
        delBtn.style.padding = '7px 12px';
        delBtn.title = 'حذف هذه العلامة';
        delBtn.innerHTML = `<span>🗑️</span> <span>حذف</span>`;
        delBtn.addEventListener('click', async () => {
          try {
            await send({
              type: 'PLUS_DELETE_BOOKMARK',
              sessionId: session.id,
              bookmarkId: bookmark.id
            });
            showToast('تم حذف العلامة');
            await reloadAll();
          } catch (err) {
            showToast(`تعذر حذف العلامة: ${err.message}`, 'error');
          }
        });
        actions.append(playBtn, viewBtn, delBtn);
      } else {
        actions.append(playBtn, viewBtn);
      }
    }

    card.append(head, note, actions);
    elements.momentsList.append(card);
  });
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

let noteController = null;
let detailSearchTimer = null;

async function flushPendingNote() {
  if (!noteController) return true;
  return noteController.flush();
}

async function openDetail(id, seekMs = null) {
  try {
    if (!(await leaveDetailSafely())) return;
    let session = await getSavedSession(id);
    if (!session) {
      const drafts = await readUnsavedDrafts();
      session = drafts.find((d) => d.id === id);
    }
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
      commit: async (sessionId, note) => {
        try {
          await send({ type: 'PLUS_UPDATE_NOTES', sessionId, notes: note });
          if (activeDetail && activeDetail.id === sessionId) {
            activeDetail.notes = note;
          }
          elements.notesStatus.textContent = 'تم حفظ الملاحظة';
          setTimeout(() => {
            if (elements.notesStatus.textContent === 'تم حفظ الملاحظة') elements.notesStatus.textContent = '';
          }, 2500);
          return true;
        } catch (error) {
          elements.notesStatus.textContent = `فشل حفظ الملاحظة: ${error.message}`;
          showToast(`تعذر حفظ الملاحظة: ${error.message}`, 'error');
          return false;
        }
      }
    });

    renderTranscript(session);
    renderBookmarks(session);
    setView('detail');

    if (seekMs !== null) {
      setTimeout(() => {
        const rows = Array.from(elements.transcriptView.querySelectorAll('.t-row'));
        if (rows.length) {
          let closest = rows[0];
          let minDiff = Math.abs(Number(closest.dataset.time || 0) - seekMs);
          for (const r of rows) {
            const diff = Math.abs(Number(r.dataset.time || 0) - seekMs);
            if (diff < minDiff) {
              minDiff = diff;
              closest = r;
            }
          }
          closest.scrollIntoView({ behavior: 'smooth', block: 'center' });
          closest.classList.add('is-highlighted');
          setTimeout(() => closest.classList.remove('is-highlighted'), 3000);
        }
      }, 100);
    }
  } catch (error) {
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
      const rows = Array.from(elements.transcriptView.querySelectorAll('.t-row'));
      if (!rows.length) return;
      let closest = rows[0];
      let minDiff = Math.abs(Number(closest.dataset.time || 0) - bookmark.atMs);
      for (const row of rows) {
        const diff = Math.abs(Number(row.dataset.time || 0) - bookmark.atMs);
        if (diff < minDiff) {
          minDiff = diff;
          closest = row;
        }
      }
      closest.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    const note = document.createElement('span');
    note.className = 'panel-copy';
    note.textContent = bookmark.note || 'علامة زمنية';

    item.append(time, note);
    elements.bookmarkList.append(item);
  }
}

elements.notesEditor.addEventListener('input', () => {
  if (noteController && activeDetail) {
    noteController.schedule(activeDetail.id, elements.notesEditor.value);
  }
});

elements.detailSearch.addEventListener('input', () => {
  if (!activeDetail) return;
  clearTimeout(detailSearchTimer);
  detailSearchTimer = setTimeout(() => renderTranscript(activeDetail, elements.detailSearch.value.trim()), 150);
});

elements.backToList.addEventListener('click', async () => {
  if (!(await leaveDetailSafely())) return;
  activeDetail = null;
  setView('library');
});

elements.openOriginal.addEventListener('click', () => {
  if (activeDetail?.pageUrl) void openPageUrl(activeDetail.pageUrl, 'تعذر فتح الصفحة الأصلية.');
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
  closeAllDropdowns();
  elements.printArea.replaceChildren();

  const printRows = toPrintRows(activeDetail);
  const container = document.createElement('div');
  container.className = 'print-document';

  const head = document.createElement('header');
  head.className = 'print-header';

  const brand = document.createElement('div');
  brand.className = 'print-brand';
  brand.textContent = 'dablaja Plus دبلجة';

  const h1 = document.createElement('h1');
  h1.className = 'print-title';
  h1.textContent = activeDetail.title;

  const meta = document.createElement('p');
  meta.className = 'print-meta';
  meta.textContent = `${siteLabel(activeDetail)} · ${formatDate(activeDetail.startedAt)} · ${formatDuration(activeDetail.durationMs)}${activeDetail.pageUrl ? ' · ' + activeDetail.pageUrl : ''}`;

  head.append(brand, h1, meta);
  container.append(head);

  if (activeDetail.notes) {
    const notesBox = document.createElement('div');
    notesBox.className = 'print-notes';
    const notesTitle = document.createElement('h3');
    notesTitle.textContent = 'الملاحظات:';
    const notesBody = document.createElement('p');
    notesBody.textContent = activeDetail.notes;
    notesBox.append(notesTitle, notesBody);
    container.append(notesBox);
  }

  const table = document.createElement('div');
  table.className = 'print-transcript';

  for (const row of printRows) {
    const item = document.createElement('div');
    item.className = 'print-row';

    const stamp = document.createElement('span');
    stamp.className = 'print-stamp';
    stamp.textContent = formatStamp(row.atMs);

    const body = document.createElement('div');
    body.className = 'print-text';

    if (row.target) {
      const ar = document.createElement('p');
      ar.className = 'print-ar';
      ar.dir = 'rtl';
      ar.textContent = row.target;
      body.append(ar);
    }
    if (row.source) {
      const en = document.createElement('p');
      en.className = 'print-en';
      en.dir = 'ltr';
      en.textContent = row.source;
      body.append(en);
    }

    item.append(stamp, body);
    table.append(item);
  }

  container.append(table);
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

function makeProfileVolumeControl(profile, origin, kind, defaultPercent) {
  const isOriginal = kind === 'original';
  const field = isOriginal ? 'originalVolume' : 'dubbedVolume';
  const max = isOriginal ? 100 : 150;
  const fallback = Number.isFinite(defaultPercent) ? defaultPercent : (isOriginal ? 25 : 100);
  const stored = Number(profile[field]);
  const percent = Number.isFinite(stored)
    ? Math.max(0, Math.min(max, Math.round(stored * 100)))
    : fallback;

  const wrap = document.createElement('label');
  wrap.className = 'profile-volume';

  const name = document.createElement('span');
  name.className = 'profile-volume-name';
  name.textContent = isOriginal ? 'الأصلي' : 'الدبلجة';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(max);
  slider.step = '1';
  slider.value = String(percent);
  slider.className = 'profile-volume-slider';
  slider.setAttribute('aria-label', `${isOriginal ? 'مستوى الصوت الأصلي' : 'مستوى صوت الدبلجة'} — ${origin}`);

  const output = document.createElement('output');
  output.className = 'profile-volume-value';
  output.textContent = `${percent}%`;

  slider.addEventListener('input', () => {
    output.textContent = `${slider.value}%`;
  });
  slider.addEventListener('change', async () => {
    const value = Number(slider.value) / 100;
    slider.disabled = true;
    try {
      const response = await send({
        type: 'PLUS_UPDATE_SITE_PROFILE',
        origin,
        originalVolume: isOriginal ? value : null,
        dubbedVolume: isOriginal ? null : value
      });
      if (response.plus) plusSettings = response.plus;
      showToast('تم حفظ مستوى الصوت.');
    } catch (error) {
      slider.value = String(percent);
      output.textContent = `${percent}%`;
      showToast(`فشل الحفظ: ${error.message}`, 'error');
    } finally {
      slider.disabled = false;
    }
  });

  wrap.append(name, slider, output);
  return wrap;
}

async function renderSettings() {
  try {
    const status = await send({ type: 'PLUS_GET_STATUS' });
    if (status?.plus) plusSettings = status.plus;
  } catch {}

  elements.rememberVolumesToggle.checked = plusSettings?.rememberVolumes === true;
  if (elements.localSavingToggle) elements.localSavingToggle.checked = plusSettings?.localSavingEnabled !== false;

  let extSettings = null;
  try {
    const res = await send({ type: 'GET_STATE' });
    extSettings = res?.settings || null;
  } catch {
    extSettings = null;
  }

  if (elements.autoDuckingToggle) {
    elements.autoDuckingToggle.checked = extSettings?.autoDucking !== false;
  }
  if (elements.analyticsToggle) {
    elements.analyticsToggle.checked = extSettings?.analyticsConsent === true;
  }

  const profiles = Array.isArray(plusSettings?.siteProfiles) ? plusSettings.siteProfiles : [];
  elements.profileList.replaceChildren();
  elements.noProfiles.classList.toggle('hidden', profiles.length > 0);

  for (const profile of profiles) {
    const origin = String(profile?.origin || '');
    if (!origin) continue;
    const li = document.createElement('li');
    li.className = 'profile-row';

    const head = document.createElement('div');
    head.className = 'profile-row-head';

    const label = document.createElement('span');
    label.className = 'profile-site';
    label.textContent = SITE_LABELS.get(origin) || origin;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-utility';
    del.style.color = '#C53030';
    del.textContent = 'حذف';
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        await send({ type: 'PLUS_DELETE_SITE_PROFILE', origin });
        showToast(`تم حذف إعدادات ${origin}`);
        await reloadAll();
      } catch (error) {
        showToast(error?.message || `تعذر حذف إعدادات ${origin}.`, 'error');
      } finally {
        del.disabled = false;
      }
    });

    head.append(label, del);

    const volumes = document.createElement('div');
    volumes.className = 'profile-volumes';
    volumes.append(
      makeProfileVolumeControl(profile, origin, 'original', 25),
      makeProfileVolumeControl(profile, origin, 'dubbed', 100)
    );

    li.append(head, volumes);
    elements.profileList.append(li);
  }

  const isPlus = plusEnabled();
  if (isPlus) {
    if (elements.topPlusBadge) {
      elements.topPlusBadge.innerHTML = '<span>Plus</span><span class="diamond-icon" aria-hidden="true">💎</span>';
      elements.topPlusBadge.title = 'Plus مدى الحياة مفعّل';
      elements.topPlusBadge.setAttribute('aria-label', 'Plus مدى الحياة مفعّل — عرض التفاصيل');
    }
    if (elements.aboutPlusTag) elements.aboutPlusTag.textContent = 'ترخيص مدى الحياة مفعل';
    if (elements.plusUpgradeBlock) elements.plusUpgradeBlock.classList.add('hidden');
    if (elements.plusActiveActions) elements.plusActiveActions.classList.remove('hidden');
  } else {
    if (elements.topPlusBadge) {
      elements.topPlusBadge.innerHTML = '<span>الخطة المجانية</span><span class="diamond-icon" aria-hidden="true">✨</span>';
      elements.topPlusBadge.title = 'النسخة المجانية — انقر للترقية إلى Plus (10$)';
      elements.topPlusBadge.setAttribute('aria-label', 'الخطة المجانية — عرض خيارات Plus');
    }
    if (elements.aboutPlusTag) elements.aboutPlusTag.innerHTML = 'النسخة المجانية — جلسة محفوظة واحدة';
    if (elements.plusUpgradeBlock) elements.plusUpgradeBlock.classList.remove('hidden');
    if (elements.plusActiveActions) elements.plusActiveActions.classList.add('hidden');
  }

  const oldBanner = elements.profileList.parentElement.querySelector('.free-limit-banner');
  if (oldBanner) oldBanner.remove();

  if (!isPlus && profiles.length >= 1) {
    const upgradeBanner = document.createElement('div');
    upgradeBanner.className = 'free-limit-banner';
    upgradeBanner.innerHTML = `
      <div class="free-limit-content">
        <strong class="free-limit-title">النسخة المجانية (<bdi>1/1</bdi> موقع محفوظ)</strong>
        <span class="free-limit-sub">احصل على <bdi>Plus</bdi> لحفظ وتخصيص مستويات الصوت حتى 50 موقع.</span>
      </div>
      <button type="button" class="free-limit-btn">ترقية إلى <bdi>Plus</bdi> (<bdi>10$</bdi>)</button>
    `;
    upgradeBanner.querySelector('button').addEventListener('click', (e) => {
      triggerCheckout(e.currentTarget);
    });
    elements.profileList.after(upgradeBanner);
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

if (elements.autoDuckingToggle) {
  elements.autoDuckingToggle.addEventListener('change', async () => {
    try {
      await send({ type: 'SET_AUTO_DUCKING', enabled: elements.autoDuckingToggle.checked });
      showToast(elements.autoDuckingToggle.checked ? 'تم تفعيل خفض الصوت الأصلي تلقائياً.' : 'تم إيقاف خفض الصوت الأصلي تلقائياً.');
    } catch (err) {
      elements.autoDuckingToggle.checked = !elements.autoDuckingToggle.checked;
      showToast(`فشل الحفظ: ${err.message}`, 'error');
    }
  });
}

elements.rememberVolumesToggle.addEventListener('change', () => persistPlusToggle(
  elements.rememberVolumesToggle,
  'PLUS_SET_REMEMBER_VOLUMES',
  elements.rememberVolumesToggle.checked
    ? 'سيتم تذكر مستويات الصوت لكل موقع.'
    : 'تم إيقاف تطبيق مستويات الصوت المحفوظة.',
  elements.audioStatus
));

if (elements.analyticsToggle) {
  elements.analyticsToggle.addEventListener('change', async () => {
    const value = elements.analyticsToggle.checked;
    elements.analyticsToggle.disabled = true;
    try {
      await send({ type: 'SET_ANALYTICS_CONSENT', value });
      showToast(value ? 'تم تفعيل مشاركة الإحصاءات المجهولة.' : 'تم إيقاف مشاركة الإحصاءات.');
    } catch (error) {
      elements.analyticsToggle.checked = !value;
      showToast(`فشل الحفظ: ${error.message}`, 'error');
    } finally {
      elements.analyticsToggle.disabled = false;
    }
  });
}

if (elements.localSavingToggle) {
  elements.localSavingToggle.addEventListener('change', async () => {
    const value = elements.localSavingToggle.checked;
    try {
      const res = await send({ type: 'PLUS_SET_LOCAL_SAVING', value });
      plusSettings = res.plus;
      showToast(value ? 'تم تفعيل حفظ الجلسات محلياً' : 'تم إيقاف حفظ الجلسات');
      const drafts = await readUnsavedDrafts();
      if (!value && drafts.length) {
        const confirmed = await confirmModal({ title: 'حذف المسودات المؤقتة؟', copy: 'يوجد مسودات مؤقتة محفوظة. هل تريد حذفها الآن؟ لن يتم حذف الجلسات المحفوظة.', confirmLabel: 'حذف المسودات' });
        if (confirmed) {
          for (const d of drafts) await send({ type: 'PLUS_DISCARD_DRAFT', draftId: d.id }).catch(()=>{});
          await reloadAll();
        }
      }
      await renderSettings();
      await renderDraftCard();
    } catch (e) {
      elements.localSavingToggle.checked = !value;
      showToast(e?.message || 'تعذر حفظ الاختيار', 'error');
    }
  });
}

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

// ---------------------------------------------------------------------------
// Search & Filter listeners
// ---------------------------------------------------------------------------

let librarySearchTimer = null;
elements.searchInput.addEventListener('input', () => {
  clearTimeout(librarySearchTimer);
  librarySearchTimer = setTimeout(renderList, 150);
});
function updateResetVisibility() {
  const dirty = elements.sortDate.value !== 'newest' ||
    elements.filterDuration.value !== 'all' ||
    elements.filterSite.value !== 'all';
  elements.resetFilters.classList.toggle('hidden', !dirty);
}

elements.sortDate.addEventListener('change', () => { updateResetVisibility(); renderList(); });
elements.filterDuration.addEventListener('change', () => { updateResetVisibility(); renderList(); });
elements.filterSite.addEventListener('change', () => { updateResetVisibility(); renderList(); });
elements.resetFilters.addEventListener('click', () => {
  elements.searchInput.value = '';
  activeCategory = 'all';
  elements.sortDate.value = 'newest';
  elements.filterDuration.value = 'all';
  elements.filterSite.value = 'all';
  updateResetVisibility();
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

function openActivationModal() {
  if (elements.activationModal) {
    activationModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    elements.activationModal.classList.remove('hidden');
    elements.activationStatus?.classList.add('hidden');
    if (elements.activationInput) {
      elements.activationInput.value = '';
      elements.activationInput.focus();
    }
  }
}

function closeActivationModal() {
  if (activationPending) return false;
  elements.activationModal?.classList.add('hidden');
  if (elements.activationInput) elements.activationInput.value = '';
  if (elements.activationStatus) {
    elements.activationStatus.textContent = '';
    elements.activationStatus.classList.add('hidden');
  }
  activationModalReturnFocus?.focus?.();
  activationModalReturnFocus = null;
  return true;
}

if (elements.openActivationBtn) {
  elements.openActivationBtn.addEventListener('click', openActivationModal);
}
if (elements.activationCancel) {
  elements.activationCancel.addEventListener('click', closeActivationModal);
}
if (elements.activationModal) {
  elements.activationModal.addEventListener('click', (event) => {
    if (event.target === elements.activationModal) closeActivationModal();
  });
}
let checkoutPending = false;
async function triggerCheckout(buttonEl) {
  if (checkoutPending) return;
  checkoutPending = true;
  if (buttonEl) buttonEl.disabled = true;
  try {
    await send({ type: 'PLUS_START_CHECKOUT' });
  } catch (e) {
    showToast(e?.message || 'تعذر إنشاء جلسة الدفع. حاول لاحقاً.', 'error');
  } finally {
    checkoutPending = false;
    if (buttonEl) buttonEl.disabled = false;
  }
}

if (elements.modalUpgradeCheckoutBtn) {
  elements.modalUpgradeCheckoutBtn.addEventListener('click', (e) => {
    triggerCheckout(e.currentTarget);
  });
}
if (elements.upgradeTopBtn) {
  elements.upgradeTopBtn.addEventListener('click', (e) => {
    triggerCheckout(e.currentTarget);
  });
}
if (elements.activateTopBtn) {
  elements.activateTopBtn.addEventListener('click', openActivationModal);
}
if (elements.libUpgradeBtn) {
  elements.libUpgradeBtn.addEventListener('click', (e) => {
    triggerCheckout(e.currentTarget);
  });
}
if (elements.topPlusBadge) {
  elements.topPlusBadge.addEventListener('click', async (e) => {
    if (!plusEnabled()) {
      triggerCheckout(e.currentTarget);
      return;
    }
    if (!(await leaveDetailSafely())) return;
    setView('settings');
  });
}

if (elements.activationSubmit) {
  elements.activationSubmit.addEventListener('click', async () => {
    if (activationPending) return;
    const code = elements.activationInput?.value.trim().toUpperCase();
    if (!code) {
      elements.activationStatus.textContent = 'الرجاء إدخال رمز الاسترداد.';
      elements.activationStatus.classList.remove('hidden');
      elements.activationStatus.style.color = '#C53030';
      return;
    }
    if (!RECOVERY_CODE_PATTERN.test(code)) {
      elements.activationStatus.textContent = 'الصيغة: DABLAJA-XXXXXXXXXXXXXXXXXXXX (من صفحة نجاح الدفع).';
      elements.activationStatus.classList.remove('hidden');
      elements.activationStatus.style.color = '#C53030';
      return;
    }
    activationPending = true;
    elements.activationSubmit.disabled = true;
    if (elements.activationCancel) elements.activationCancel.disabled = true;
    if (elements.modalUpgradeCheckoutBtn) elements.modalUpgradeCheckoutBtn.disabled = true;
    elements.activationStatus.textContent = 'جارٍ التحقق من الرمز…';
    elements.activationStatus.style.color = '#16324f';
    elements.activationStatus.classList.remove('hidden');
    try {
      const res = await send({ type: 'PLUS_RECOVER_LICENSE', code });
      if (res?.ok) {
        elements.activationStatus.textContent = 'تم تفعيل ترخيص Plus بنجاح! 🎉';
        elements.activationStatus.style.color = '#0d6f68';
        showToast('تم تفعيل dablaja Plus مدى الحياة بنجاح!');
        setTimeout(() => {
          closeActivationModal();
          reloadAll();
        }, 1200);
      }
    } catch (err) {
      elements.activationStatus.textContent = err.message || 'رمز الاسترداد غير صحيح.';
      elements.activationStatus.style.color = '#C53030';
    } finally {
      activationPending = false;
      elements.activationSubmit.disabled = false;
      if (elements.activationCancel) elements.activationCancel.disabled = false;
      if (elements.modalUpgradeCheckoutBtn) elements.modalUpgradeCheckoutBtn.disabled = false;
    }
  });
}

if (elements.activationInput) {
  elements.activationInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      elements.activationSubmit?.click();
    }
  });
}

// Recovery-code rotation: production controller lives in
// src/shared/rotation-controller.js so both the real library page and its
// tests exercise the same implementation.
const rotationController = createRotationController({
  elements,
  send: (msg) => send(msg),
  clipboard: globalThis.navigator?.clipboard || null,
  showToast
});
rotationController.bind();
const openRotateRecoveryModal = rotationController.openModal.bind(rotationController);
const closeRotateRecoveryModal = rotationController.closeModal.bind(rotationController);

if (window.location.hash === '#activate') {
  openActivationModal();
}

// Keep every open library surface synchronized with worker-side draft,
// storage, checkout, renewal and revocation events.
chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'PLUS_DRAFT_CHANGED':
      renderDraftCard().catch(() => undefined);
      renderStats();
      break;
    case 'PLUS_STORAGE_WARNING':
      showToast(message.message || 'تعذر حفظ مسودة الجلسة مؤقتاً على هذا الجهاز.', 'error');
      renderDraftCard().catch(() => undefined);
      break;
    case 'PLUS_LICENSE_ACTIVATED':
      closeActivationModal();
      showToast('تم تفعيل dablaja Plus مدى الحياة بنجاح! 🎉');
      reloadAll().catch(() => undefined);
      break;
    case 'PLUS_LICENSE_REVOKED':
      showToast('تم إلغاء ترخيص Plus. عادت حدود الخطة المجانية إلى هذا الجهاز.', 'error');
      reloadAll().catch(() => undefined);
      break;
    case 'PLUS_POLL_TIMEOUT':
    case 'PLUS_POLL_FAILED':
      showToast(message.error || 'تعذر تأكيد الدفع. افتح تفاصيل Plus للمحاولة مجدداً.', 'error');
      break;
    default:
      break;
  }
});

updateResetVisibility();
injectIcons();
window.reloadAll = reloadAll;
window.openDetail = openDetail;
window.openActivationModal = openActivationModal;
window.openRotateRecoveryModal = openRotateRecoveryModal;
window.closeRotateRecoveryModal = closeRotateRecoveryModal;
reloadAll().catch(() => undefined);
