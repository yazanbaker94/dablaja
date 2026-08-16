import { STORAGE_KEYS, SESSION_STORAGE_KEYS } from '../shared/constants.js';
import { describeEntitlement, ENTITLEMENT_STATES } from '../shared/plus-entitlement.js';
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
  entitlementChip: $('entitlementChip'),
  lockedNotice: $('lockedNotice'),
  draftSection: $('draftSection'),
  draftMeta: $('draftMeta'),
  draftBody: $('draftBody'),
  saveStatus: $('saveStatus'),
  searchInput: $('searchInput'),
  searchStatus: $('searchStatus'),
  exportBackup: $('exportBackup'),
  importFile: $('importFile'),
  importStatus: $('importStatus'),
  sessionCount: $('sessionCount'),
  sessionList: $('sessionList'),
  emptyState: $('emptyState'),
  listSection: $('listSection'),
  detailSection: $('detailSection'),
  detailTitle: $('detailTitle'),
  detailMeta: $('detailMeta'),
  transcriptView: $('transcriptView'),
  notesEditor: $('notesEditor'),
  notesStatus: $('notesStatus'),
  bookmarkList: $('bookmarkList'),
  noBookmarks: $('noBookmarks'),
  openOriginal: $('openOriginal'),
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
  profileList: $('profileList'),
  noProfiles: $('noProfiles'),
  deleteAll: $('deleteAll'),
  storageInfo: $('storageInfo'),
  backToTab: $('backToTab')
};

let plusSettings = null;
let sessions = [];
let activeDetail = null;
let deleteAllArmed = false;

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatStamp(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes) {
  if (!bytes) return '0 بايت';
  const units = ['بايت', 'كيلوبايت', 'ميغابايت'];
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

function showSaveStatus(message = '', tone = '') {
  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle('hidden', !message);
  elements.saveStatus.classList.toggle('notice-error', tone === 'error');
  elements.saveStatus.classList.toggle('notice-success', tone === 'success');
}

function showSearchStatus(message = '') {
  elements.searchStatus.textContent = message;
  elements.searchStatus.classList.toggle('hidden', !message);
}

function showSettingsStatus(message = '', error = false) {
  elements.settingsStatus.textContent = message;
  elements.settingsStatus.classList.toggle('hidden', !message);
  elements.settingsStatus.classList.toggle('settings-error', error);
}

function detailIsOpen() {
  return Boolean(activeDetail) && !elements.detailSection.classList.contains('hidden');
}

function requireSavedRecord(response, expectedId) {
  const savedId = response?.saved?.id;
  if (!savedId || (expectedId && savedId !== expectedId)) {
    throw new Error('لم تؤكد قاعدة البيانات حفظ الجلسة. أعد تحميل الإضافة ثم حاول مرة أخرى.');
  }
  return response.saved;
}

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

// ---- Draft card -----------------------------------------------------------

async function readUnsavedDrafts() {
  const stored = await chrome.storage.session.get(SESSION_STORAGE_KEYS.PLUS_UNSAVED_DRAFTS);
  const list = stored[SESSION_STORAGE_KEYS.PLUS_UNSAVED_DRAFTS];
  return (Array.isArray(list) ? list : []).map((draft) => validateSessionRecord(draft)).filter(Boolean);
}

async function renderDraftCard() {
  const status = await send({ type: 'PLUS_GET_STATUS' });
  plusSettings = status.plus;
  // Consistent shape: `draft` IS the active draft summary (or null).
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
    stat.className = 'stat muted';
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
      makeStat('بدأت', formatStamp(Date.now() - active.startedAt))
    );
    if (active.truncated === true) {
      const truncated = document.createElement('span');
      truncated.className = 'stat muted';
      truncated.textContent = 'تنبيه: اقتُطع أقدم جزء من المسودة بسبب حدود التخزين المحلي';
      info.append(truncated);
    }
    if (active.saved === true) {
      const savedNote = document.createElement('span');
      savedNote.className = 'stat muted';
      savedNote.textContent = 'محفوظة — وستُحدَّث حتى تتوقف الدبلجة';
      info.append(savedNote);
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary-button';
    save.textContent = 'احفظ الجلسة';
    save.disabled = !plusEnabled();
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.setAttribute('aria-busy', 'true');
      save.textContent = 'جارٍ الحفظ…';
      showSaveStatus('جارٍ حفظ الجلسة محلياً على هذا الجهاز…');
      try {
        const response = await send({ type: 'PLUS_SAVE_ACTIVE' });
        requireSavedRecord(response, active.id);
        showSaveStatus('تم حفظ الجلسة. ستستمر في التحديث حتى تتوقف الدبلجة.', 'success');
        await reloadAll();
      } catch (error) {
        showSaveStatus(`تعذر حفظ الجلسة: ${error.message}`, 'error');
        save.disabled = false;
        save.removeAttribute('aria-busy');
        save.textContent = 'احفظ الجلسة';
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
      save.className = 'ghost-button';
      save.textContent = 'حفظ';
      save.disabled = !plusEnabled();
      save.addEventListener('click', async () => {
        save.disabled = true;
        save.setAttribute('aria-busy', 'true');
        save.textContent = 'جارٍ الحفظ…';
        showSaveStatus('جارٍ نقل الجلسة إلى الجلسات المحفوظة…');
        try {
          const response = await send({ type: 'PLUS_SAVE_UNSAVED', draftId: draft.id });
          requireSavedRecord(response, draft.id);
          showSaveStatus('تم حفظ الجلسة ونقلها إلى قائمة الجلسات المحفوظة.', 'success');
          await reloadAll();
        } catch (error) {
          showSaveStatus(`تعذر حفظ الجلسة: ${error.message}`, 'error');
          save.disabled = false;
          save.removeAttribute('aria-busy');
          save.textContent = 'حفظ';
        }
      });
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'tool-button danger';
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
}

// ---- Session list ---------------------------------------------------------

function sessionCard(summary) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'session-card';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = summary.title;
  const meta = document.createElement('div');
  meta.className = 'meta-row';
  const parts = [
    summary.siteOrigin || '',
    formatDate(summary.updatedAt),
    summary.durationMs ? formatDuration(summary.durationMs) : '',
    `${summary.lineCount} سطر`,
    summary.bookmarkCount ? `${summary.bookmarkCount} علامة` : '',
    summary.hasNotes ? 'ملاحظات' : ''
  ].filter(Boolean);
  meta.textContent = parts.join(' · ');
  card.append(title, meta);
  card.addEventListener('click', () => openDetail(summary.id));
  return card;
}

function renderList() {
  const query = elements.searchInput.value.trim();
  const results = searchSessions(sessions, query);
  elements.sessionList.replaceChildren(...results.map(sessionCard));
  elements.sessionCount.textContent = sessions.length ? `(${sessions.length})` : '';
  elements.emptyState.classList.toggle('hidden', results.length > 0);
  showSearchStatus(query
    ? (results.length ? `${results.length} جلسة مطابقة` : 'لا توجد جلسات تطابق هذا البحث.')
    : '');
}

// ---- Detail view ----------------------------------------------------------

function renderTranscript(session, query = '') {
  const allRows = toPrintRows(session);
  const rows = searchTranscriptRows(allRows, query);
  const view = elements.transcriptView;
  view.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = query
      ? 'لا يوجد سطر في هذه الجلسة يطابق البحث.'
      : 'لا توجد نصوص محفوظة في هذه الجلسة.';
    view.append(empty);
    showSearchStatus(query ? '0 نتيجة داخل نص الجلسة.' : '');
    return;
  }
  for (const row of rows) {
    const container = document.createElement('div');
    container.className = 'transcript-row';
    container.classList.toggle('search-match', Boolean(query));
    if (row.atMs != null) {
      const stamp = document.createElement('span');
      stamp.className = 'stamp';
      stamp.textContent = formatStamp(row.atMs);
      container.append(stamp);
    }
    const en = document.createElement('p');
    en.className = 'en';
    en.textContent = row.source || 'لم يصل نص إنجليزي لهذا الجزء.';
    en.classList.toggle('missing-translation', row.missingSource === true);
    const ar = document.createElement('p');
    ar.className = 'ar';
    ar.textContent = row.target || 'لم تصل ترجمة عربية لهذا الجزء.';
    ar.classList.toggle('missing-translation', row.missingTarget === true);
    container.append(en, ar);
    view.append(container);
  }
  showSearchStatus(query ? `${rows.length} نتيجة داخل نص الجلسة.` : '');
}

function renderBookmarks(session) {
  const list = elements.bookmarkList;
  list.replaceChildren();
  elements.noBookmarks.classList.toggle('hidden', session.bookmarks.length > 0);
  for (const bookmark of session.bookmarks) {
    const item = document.createElement('li');
    item.className = 'bookmark-item';
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = formatStamp(bookmark.atMs);
    const note = document.createElement('span');
    note.textContent = bookmark.note || '—';
    const tools = document.createElement('div');
    tools.className = 'tools';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'tool-button';
    edit.textContent = 'تعديل';
    edit.disabled = !plusEnabled();
    edit.addEventListener('click', () => {
      const input = document.createElement('input');
      input.value = bookmark.note;
      input.setAttribute('aria-label', 'نص العلامة');
      note.replaceWith(input);
      input.focus();
      const commit = async () => {
        try {
          // Paid mutation — routed through the service worker, which enforces
          // entitlement centrally (UI disabled states are not trusted).
          const response = await send({
            type: 'PLUS_UPDATE_BOOKMARK',
            sessionId: session.id,
            bookmarkId: bookmark.id,
            note: input.value
          });
          applyDetailRecord(response.session);
          renderBookmarks(activeDetail);
        } catch (error) {
          window.alert(error.message);
        }
      };
      input.addEventListener('blur', commit, { once: true });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        }
      });
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tool-button danger';
    remove.textContent = 'حذف';
    remove.addEventListener('click', async () => {
      try {
        const response = await send({
          type: 'PLUS_DELETE_BOOKMARK',
          sessionId: session.id,
          bookmarkId: bookmark.id
        });
        applyDetailRecord(response.session);
        renderBookmarks(activeDetail);
      } catch (error) {
        window.alert(error.message);
      }
    });
    tools.append(edit, remove);
    item.append(stamp, note, tools);
    list.append(item);
  }
}

function applyDetailRecord(record) {
  if (!record || !activeDetail || record.id !== activeDetail.id) return;
  activeDetail = record;
  const index = sessions.findIndex((session) => session.id === record.id);
  if (index >= 0) sessions[index] = record;
}

async function openDetail(id) {
  // Interactive navigation: stop if a pending note write failed so the edit
  // is never silently discarded.
  if (!(await flushPendingNote())) {
    window.alert('تعذر حفظ ملاحظة هذه الجلسة. أعد المحاولة قبل فتح جلسة أخرى.');
    return;
  }
  const session = sessions.find((item) => item.id === id) || await getSavedSession(id);
  if (!session) return;
  activeDetail = session;
  elements.detailTitle.textContent = session.title || session.siteOrigin || 'جلسة';
  elements.detailMeta.textContent = [
    session.siteOrigin || '',
    formatDate(session.updatedAt),
    session.durationMs ? formatDuration(session.durationMs) : '',
    `${transcriptLineCount(session)} سطر`
  ].filter(Boolean).join(' · ');
  elements.searchInput.placeholder = 'ابحث داخل نص هذه الجلسة…';
  renderTranscript(session, elements.searchInput.value.trim());
  elements.notesEditor.value = session.notes || '';
  elements.notesEditor.readOnly = !plusEnabled();
  elements.notesStatus.textContent = plusEnabled() ? '' : 'Plus غير مفعّل — الملاحظات للقراءة فقط';
  renderBookmarks(session);
  elements.openOriginal.disabled = !session.pageUrl;
  elements.exportSrt.disabled = !hasSrtTimestamps(session);
  elements.listSection.classList.add('hidden');
  elements.detailSection.classList.remove('hidden');
  elements.printArea.replaceChildren();
  window.scrollTo(0, 0);
}

async function closeDetail() {
  if (!(await flushPendingNote())) {
    window.alert('تعذر حفظ ملاحظة هذه الجلسة. أعد المحاولة قبل العودة للقائمة.');
    return;
  }
  activeDetail = null;
  elements.searchInput.placeholder = 'ابحث في العناوين والملاحظات والنصوص…';
  elements.detailSection.classList.add('hidden');
  elements.listSection.classList.remove('hidden');
  renderList();
}

function buildPrintArea(session) {
  const area = elements.printArea;
  area.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = session.title || 'جلسة دبلجة';
  const meta = document.createElement('p');
  meta.className = 'print-meta';
  meta.textContent = [
    session.siteOrigin || '',
    session.pageUrl || '',
    formatDate(session.updatedAt),
    session.durationMs ? formatDuration(session.durationMs) : ''
  ].filter(Boolean).join(' · ');
  const notes = document.createElement('p');
  notes.className = 'print-meta';
  notes.textContent = session.notes || '';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['English', 'العربية']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const row of toPrintRows(session)) {
    const tr = document.createElement('tr');
    const en = document.createElement('td');
    en.dir = 'ltr';
    en.textContent = row.source;
    const ar = document.createElement('td');
    ar.textContent = row.target;
    tr.append(en, ar);
    table.append(tr);
  }
  area.append(heading, meta, notes, table);
}

// ---- Settings / storage ---------------------------------------------------

function renderProfiles(profiles) {
  const list = elements.profileList;
  list.replaceChildren();
  elements.noProfiles.classList.toggle('hidden', profiles.length > 0);
  for (const profile of profiles) {
    const item = document.createElement('li');
    item.className = 'profile-item';
    const label = document.createElement('span');
    label.dir = 'ltr';
    label.textContent = profile.origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tool-button danger';
    remove.textContent = 'حذف';
    remove.addEventListener('click', async () => {
      const response = await send({ type: 'PLUS_DELETE_SITE_PROFILE', origin: profile.origin });
      plusSettings = response.plus;
      renderProfiles(plusSettings.siteProfiles || []);
    });
    item.append(label, remove);
    list.append(item);
  }
}

async function refreshStorageInfo() {
  const estimate = await estimatePlusStorage();
  elements.storageInfo.textContent = `التخزين المحلي المستخدم: ${formatBytes(estimate.usageBytes)} من ${formatBytes(estimate.quotaBytes)} · ${sessions.length} جلسة محفوظة`;
}

async function renderSettings() {
  elements.autosaveToggle.checked = plusSettings?.autosave === true;
  elements.rememberVolumesToggle.checked = plusSettings?.rememberVolumes === true;
  renderProfiles(plusSettings?.siteProfiles || []);
}

async function reloadAll() {
  sessions = await listSavedSessions();
  renderList();
  await renderDraftCard();
  await renderSettings();
  await refreshStorageInfo();
  renderEntitlement();
}

function renderEntitlement() {
  const entitlement = plusSettings?.entitlement;
  if (!entitlement) return;
  elements.entitlementChip.textContent = describeEntitlement(entitlement);
  elements.entitlementChip.classList.toggle('chip-preview', entitlement.state === ENTITLEMENT_STATES.DEVELOPMENT_PREVIEW);
  const locked = !plusEnabled();
  elements.lockedNotice.classList.toggle('hidden', !locked);
  if (locked) {
    elements.lockedNotice.textContent = 'Plus غير مفعّل على هذا الجهاز حالياً. تصفح الجلسات متاح لكن الحفظ معطّل.';
  }
}

// ---- Event wiring ---------------------------------------------------------

elements.searchInput.addEventListener('input', () => {
  if (detailIsOpen()) {
    renderTranscript(activeDetail, elements.searchInput.value.trim());
    return;
  }
  renderList();
});

elements.backToList.addEventListener('click', closeDetail);

elements.backToTab.addEventListener('click', (event) => {
  event.preventDefault();
  window.close();
});

// Commits a pending note write. Returns true on success (or when another
// record owns the edit), false on a real write failure — interactive
// navigation must stop on false so an unsaved note is never discarded.
async function commitNoteSave(sessionId, value) {
  // Ownership check: only write if the same record still owns this edit.
  if (!activeDetail || activeDetail.id !== sessionId) return true;
  try {
    const response = await send({
      type: 'PLUS_UPDATE_NOTES',
      sessionId,
      notes: value
    });
    if (activeDetail && activeDetail.id === sessionId) {
      applyDetailRecord(response.session);
      elements.notesStatus.textContent = 'حُفظت الملاحظة';
    }
    return true;
  } catch (error) {
    elements.notesStatus.textContent = error?.message || 'تعذر حفظ الملاحظة';
    return false;
  }
}

// The schedule/flush machine (single-write, ownership-captured, debounced)
// lives in the shared, unit-tested note-flush module.
const noteFlush = createNoteFlushController({ commit: commitNoteSave, debounceMs: 600 });
const flushPendingNote = () => noteFlush.flush();
const scheduleNoteSave = (sessionId, value) => {
  elements.notesStatus.textContent = '…';
  noteFlush.schedule(sessionId, value);
};

elements.notesEditor.addEventListener('input', () => {
  if (!activeDetail || !plusEnabled()) return;
  scheduleNoteSave(activeDetail.id, elements.notesEditor.value);
});

// All flush points route through ONE shared flush path
// once — no duplicate writes, no lost edits.
elements.notesEditor.addEventListener('blur', () => {
  flushPendingNote();
});
window.addEventListener('pagehide', () => {
  flushPendingNote();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingNote();
});

elements.openOriginal.addEventListener('click', async () => {
  if (!activeDetail?.pageUrl) return;
  await chrome.tabs.create({ url: activeDetail.pageUrl });
});

elements.exportTxt.addEventListener('click', () => {
  if (!activeDetail) return;
  download(`${safeFilePrefix(activeDetail)}.txt`, toPlainText(activeDetail));
});

elements.exportSrt.addEventListener('click', () => {
  if (!activeDetail) return;
  download(`${safeFilePrefix(activeDetail)}.srt`, toSrt(activeDetail));
});

elements.exportJson.addEventListener('click', () => {
  if (!activeDetail) return;
  download(`${safeFilePrefix(activeDetail)}.json`, toExportJson(activeDetail), 'application/json');
});

elements.printSession.addEventListener('click', () => {
  if (!activeDetail) return;
  buildPrintArea(activeDetail);
  window.print();
});

elements.deleteSession.addEventListener('click', async () => {
  if (!activeDetail) return;
  if (!elements.deleteSession.classList.contains('armed')) {
    elements.deleteSession.classList.add('armed');
    elements.deleteSession.textContent = 'تأكيد الحذف؟';
    setTimeout(() => {
      elements.deleteSession.classList.remove('armed');
      elements.deleteSession.textContent = 'حذف الجلسة';
    }, 3000);
    return;
  }
  // Await any pending note write before deleting the record it targets;
  // a failed save must block the deletion, not lose the edit.
  const targetId = activeDetail.id;
  if (!(await flushPendingNote())) {
    window.alert('تعذر حفظ ملاحظة هذه الجلسة. أعد المحاولة قبل الحذف.');
    return;
  }
  if (activeDetail?.id !== targetId) return;
  await deleteSavedSession(targetId);
  activeDetail = null;
  elements.searchInput.placeholder = 'ابحث في العناوين والملاحظات والنصوص…';
  elements.detailSection.classList.add('hidden');
  elements.listSection.classList.remove('hidden');
  await reloadAll();
});

elements.deleteAll.addEventListener('click', async () => {
  if (!deleteAllArmed) {
    deleteAllArmed = true;
    elements.deleteAll.classList.add('armed');
    elements.deleteAll.textContent = 'تأكيد حذف كل الجلسات؟';
    setTimeout(() => {
      deleteAllArmed = false;
      elements.deleteAll.classList.remove('armed');
      elements.deleteAll.textContent = 'حذف كل الجلسات المحفوظة';
    }, 4000);
    return;
  }
  deleteAllArmed = false;
  elements.deleteAll.classList.remove('armed');
  elements.deleteAll.textContent = 'حذف كل الجلسات المحفوظة';
  if (activeDetail && !(await flushPendingNote())) {
    window.alert('تعذر حفظ ملاحظة الجلسة المفتوحة. أعد المحاولة قبل حذف كل الجلسات.');
    return;
  }
  await clearSavedSessions();
  await reloadAll();
});

async function persistPlusToggle(element, messageType, successMessage) {
  const requested = element.checked;
  element.disabled = true;
  showSettingsStatus('جارٍ حفظ الإعداد…');
  try {
    const response = await send({ type: messageType, value: requested });
    plusSettings = response.plus;
    await renderSettings();
    showSettingsStatus(successMessage);
  } catch (error) {
    // Restore the last confirmed value rather than leaving a misleading UI.
    await renderSettings();
    showSettingsStatus(`تعذر حفظ الإعداد: ${error.message}`, true);
  } finally {
    element.disabled = false;
  }
}

elements.autosaveToggle.addEventListener('change', () => persistPlusToggle(
  elements.autosaveToggle,
  'PLUS_SET_AUTOSAVE',
  elements.autosaveToggle.checked
    ? 'تم تفعيل الحفظ التلقائي عند الإيقاف.'
    : 'تم إيقاف الحفظ التلقائي.'
));

elements.rememberVolumesToggle.addEventListener('change', () => persistPlusToggle(
  elements.rememberVolumesToggle,
  'PLUS_SET_REMEMBER_VOLUMES',
  elements.rememberVolumesToggle.checked
    ? 'سيتم تذكر مستويات الصوت لكل موقع.'
    : 'تم إيقاف تطبيق مستويات الصوت المحفوظة.'
));

elements.exportBackup.addEventListener('click', async () => {
  const all = await listSavedSessions();
  download(`dablaja-plus-backup-${new Date().toISOString().slice(0, 10)}.json`, createBackup(all), 'application/json');
});

elements.importFile.addEventListener('change', async () => {
  const file = elements.importFile.files?.[0];
  elements.importFile.value = '';
  if (!file) return;
  elements.importStatus.classList.remove('hidden');
  elements.importStatus.textContent = 'جارٍ التحقق من النسخة الاحتياطية…';
  try {
    const text = await file.text();
    // Trust boundary: only the raw text crosses to the service worker, which
    // parses and validates the backup itself before writing anything.
    const result = await send({ type: 'PLUS_IMPORT_BACKUP', rawBackup: text });
    elements.importStatus.textContent = `تم الاستيراد: ${result.added} جلسة جديدة، ${result.updated} محدّثة`
      + `${result.superseded ? `، و${result.superseded} نسخة مكررة استُبدلت` : ''}`
      + `${result.invalidRecords ? `، وتجاهُل ${result.invalidRecords} سجل غير صالح` : ''}`
      + `${result.rejected ? `، ورفض ${result.rejected} تجاوزاً للحد الأقصى` : ''}.`;
    await reloadAll();
  } catch (error) {
    elements.importStatus.textContent = `فشل الاستيراد: ${error.message}`;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'PLUS_DRAFT_CHANGED') {
    renderDraftCard().catch(() => undefined);
  }
});

reloadAll().catch(() => undefined);
