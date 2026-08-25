import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRotationController } from '../src/shared/rotation-controller.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('recovery rotation UI: required DOM ids and accessible attributes exist in both pages', async () => {
  const [libHtml, prevHtml, libJs] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8')
  ]);

  const requiredIds = [
    'plusActiveActions',
    'rotateRecoveryBtn',
    'rotateRecoveryModal',
    'rotateRecoveryTitle',
    'rotateConfirmStep',
    'rotateResultStep',
    'rotateConfirmBtn',
    'rotateCancelBtn',
    'rotateResultCode',
    'rotateCopyBtn',
    'rotateCloseBtn',
    'rotateStatus'
  ];

  for (const id of requiredIds) {
    assert.ok(libHtml.includes(`id="${id}"`), `library.html missing id="${id}"`);
    assert.ok(prevHtml.includes(`id="${id}"`), `preview.html missing id="${id}"`);
    assert.ok(libJs.includes(`${id}:`), `library.js missing element binding for "${id}"`);
  }

  assert.ok(libHtml.includes('role="dialog"'), 'library.html modal must have role="dialog"');
  assert.ok(libHtml.includes('aria-modal="true"'), 'library.html modal must have aria-modal="true"');
  assert.ok(libHtml.includes('aria-labelledby="rotateRecoveryTitle"'), 'library.html modal must have aria-labelledby');
  assert.ok(prevHtml.includes('role="dialog"'), 'preview.html modal must have role="dialog"');
  assert.ok(libHtml.includes('dir="ltr"'), 'rotateResultCode must be dir="ltr"');
  assert.ok(libHtml.includes('user-select:all'), 'rotateResultCode should have user-select:all');
});

function mockElement(id) {
  const el = {
    id,
    textContent: '',
    disabled: false,
    style: {},
    classList: {
      _classes: new Set(['hidden']),
      add(cls) { this._classes.add(cls); },
      remove(cls) { this._classes.delete(cls); },
      contains(cls) { return this._classes.has(cls); }
    },
    _listeners: {},
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    removeEventListener(event, fn) {
      const arr = this._listeners[event];
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    async trigger(event, detail = {}) {
      const handlers = (this._listeners[event] || []).slice();
      for (const fn of handlers) await fn({ ...detail, target: this, currentTarget: this, preventDefault() {} });
    },
    focus() {
      el._focused = true;
    },
    _focused: false
  };
  return el;
}

function installGlobals(documentAddSpy, windowAddSpy) {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const docListeners = [];
  const winListeners = [];
  globalThis.document = {
    activeElement: null,
    addEventListener(ev, fn) {
      docListeners.push({ ev, fn });
      if (documentAddSpy) documentAddSpy(ev, fn);
    },
    removeEventListener(ev, fn) {
      const idx = docListeners.findIndex((x) => x.fn === fn && x.ev === ev);
      if (idx >= 0) docListeners.splice(idx, 1);
    },
    _listeners: docListeners
  };
  globalThis.window = {
    addEventListener(ev, fn) {
      winListeners.push({ ev, fn });
      if (windowAddSpy) windowAddSpy(ev, fn);
    },
    removeEventListener(ev, fn) {
      const idx = winListeners.findIndex((x) => x.fn === fn && x.ev === ev);
      if (idx >= 0) winListeners.splice(idx, 1);
    },
    _listeners: winListeners
  };
  return {
    restore() {
      if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
      if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    },
    docListeners,
    winListeners
  };
}

function makeElements() {
  return {
    rotateRecoveryBtn: mockElement('rotateRecoveryBtn'),
    rotateRecoveryModal: mockElement('rotateRecoveryModal'),
    rotateConfirmStep: mockElement('rotateConfirmStep'),
    rotateResultStep: mockElement('rotateResultStep'),
    rotateConfirmBtn: mockElement('rotateConfirmBtn'),
    rotateCancelBtn: mockElement('rotateCancelBtn'),
    rotateResultCode: mockElement('rotateResultCode'),
    rotateCopyBtn: mockElement('rotateCopyBtn'),
    rotateCloseBtn: mockElement('rotateCloseBtn'),
    rotateStatus: mockElement('rotateStatus')
  };
}

test('rotation controller: open/close with focus, Escape, beforeunload wipe, and DOM cleanup', async (t) => {
  const addedDocumentListeners = [];
  const addedWindowListeners = [];
  const g = installGlobals(
    (ev, fn) => addedDocumentListeners.push({ ev, fn }),
    (ev, fn) => addedWindowListeners.push({ ev, fn })
  );
  t.after(g.restore);

  const elements = makeElements();
  const controller = createRotationController({
    elements,
    send: async () => ({ ok: true, code: 'DABLAJA-X' }),
    clipboard: { async writeText() {} },
    showToast: () => {}
  });
  controller.bind();

  assert.ok(addedDocumentListeners.some((x) => x.ev === 'keydown'), 'bind wires document keydown');
  assert.ok(addedWindowListeners.some((x) => x.ev === 'beforeunload'), 'bind wires window beforeunload');

  assert.ok(elements.rotateRecoveryModal.classList.contains('hidden'));
  await elements.rotateRecoveryBtn.trigger('click');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'modal visible after open');
  assert.ok(!elements.rotateConfirmStep.classList.contains('hidden'), 'confirm step visible after open');
  assert.ok(elements.rotateResultStep.classList.contains('hidden'), 'result step hidden after open');
  assert.equal(elements.rotateStatus.textContent, '');
  assert.ok(elements.rotateStatus.classList.contains('hidden'));
  assert.equal(elements.rotateResultCode.textContent, '');
  assert.equal(elements.rotateConfirmBtn.disabled, false);

  const unload = addedWindowListeners.find((x) => x.ev === 'beforeunload').fn;
  elements.rotateResultCode.textContent = 'DABLAJA-LEAKED-CODE-12345';
  const ev = {};
  unload(ev);
  assert.equal(elements.rotateResultCode.textContent, '', 'beforeunload wipes code when not pending');
  assert.equal(ev.returnValue, undefined, 'no navigation warning when not pending');

  elements.rotateResultCode.textContent = 'DABLAJA-WILL-BE-WIPED';
  await elements.rotateCancelBtn.trigger('click');
  assert.ok(elements.rotateRecoveryModal.classList.contains('hidden'), 'cancelled modal re-hidden');
  assert.equal(elements.rotateResultCode.textContent, '', 'code wiped on cancel dismiss');

  await elements.rotateRecoveryBtn.trigger('click');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'));
  const escapeHandler = addedDocumentListeners.find((x) => x.ev === 'keydown').fn;
  await escapeHandler({ key: 'Escape' });
  assert.ok(elements.rotateRecoveryModal.classList.contains('hidden'), 'Escape closes the modal');

  controller.unbind();
});

test('rotation controller: pending guards — Escape/Close/Cancel do not dismiss while pending', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);
  const elements = makeElements();
  let release = null;
  const pendingPromise = new Promise((resolve) => { release = resolve; });
  const send = async () => pendingPromise;
  const controller = createRotationController({ elements, send, clipboard: { async writeText() {} }, showToast: () => {} });
  controller.bind();

  await elements.rotateRecoveryBtn.trigger('click');
  const confirmP = elements.rotateConfirmBtn.trigger('click');
  assert.equal(controller.isPending(), true, 'pending after confirm');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'modal still open during pending');

  await elements.rotateCancelBtn.trigger('click');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'Cancel does not dismiss while pending');
  await elements.rotateCloseBtn.trigger('click');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'Close does not dismiss while pending');

  const kd = g.docListeners.find((x) => x.ev === 'keydown');
  if (kd) await kd.fn({ key: 'Escape', preventDefault() {} });
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'Escape does not dismiss while pending');

  const unload = g.winListeners.find((x) => x.ev === 'beforeunload');
  assert.ok(unload, 'beforeunload wired');
  const ev2 = { preventDefault() {} };
  const ret = unload.fn(ev2);
  assert.equal(ev2.returnValue, '', 'beforeunload requests warning while pending');
  assert.equal(ret, '', 'beforeunload returns empty string while pending');

  release({ ok: true, code: 'DABLAJA-PENDING-RESULT-12345' });
  await confirmP;
  assert.equal(controller.isPending(), false);
  assert.ok(!elements.rotateResultStep.classList.contains('hidden'), 'result step visible after pending success');
  assert.equal(elements.rotateResultCode.textContent, 'DABLAJA-PENDING-RESULT-12345');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'response remains visible after attempted dismissal');

  controller.unbind();
});

test('rotation controller: success keeps result visible and focused; close wipes plaintext', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);
  const elements = makeElements();
  const controller = createRotationController({
    elements,
    send: async () => ({ ok: true, code: 'DABLAJA-SUCCESS-RESULT-1' }),
    clipboard: { async writeText() {} },
    showToast: () => {}
  });
  controller.bind();
  await elements.rotateRecoveryBtn.trigger('click');
  await elements.rotateConfirmBtn.trigger('click');
  assert.equal(elements.rotateResultCode.textContent, 'DABLAJA-SUCCESS-RESULT-1');
  assert.ok(elements.rotateCloseBtn._focused, 'result close button focused after success');
  assert.ok(!elements.rotateRecoveryModal.classList.contains('hidden'), 'modal stays open on success');
  await elements.rotateCloseBtn.trigger('click');
  assert.equal(elements.rotateResultCode.textContent, '', 'code wiped on completed close');
  controller.unbind();
});

test('rotation controller: network ambiguity message and retry produces new code', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);
  const elements = makeElements();
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) throw new Error('Failed to fetch');
    return { ok: true, code: 'DABLAJA-RETRY-CODE-99999' };
  };
  const controller = createRotationController({ elements, send, clipboard: { async writeText() {} }, showToast: () => {} });
  controller.bind();
  await elements.rotateRecoveryBtn.trigger('click');
  await elements.rotateConfirmBtn.trigger('click');
  assert.ok(elements.rotateStatus.textContent.includes('الشبكة') || elements.rotateStatus.textContent.includes('حاول'), 'Arabic retry guidance shown');
  assert.equal(elements.rotateConfirmBtn.disabled, false, 'confirm re-enabled after ambiguity');
  await elements.rotateConfirmBtn.trigger('click');
  assert.equal(elements.rotateResultCode.textContent, 'DABLAJA-RETRY-CODE-99999', 'retry produced new valid code');
  controller.unbind();
});

test('rotation controller: Tab focus trap cycles only through the visible modal step', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);
  const elements = makeElements();
  const controller = createRotationController({ elements, send: async () => ({ ok: true, code: 'DABLAJA-X' }), clipboard: { async writeText() {} }, showToast: () => {} });
  controller.bind();
  await elements.rotateRecoveryBtn.trigger('click');
  const trap = g.docListeners.find((x) => x.fn.name === 'handleFocusTrap');
  assert.ok(trap, 'trap handler wired');

  let prevented = 0;
  globalThis.document.activeElement = elements.rotateCancelBtn;
  trap.fn({ key: 'Tab', shiftKey: false, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.ok(elements.rotateConfirmBtn._focused, 'forward Tab wraps to first visible confirm control');
  assert.equal(elements.rotateCloseBtn._focused, false, 'hidden result control is never focused');

  elements.rotateConfirmBtn._focused = false;
  globalThis.document.activeElement = elements.rotateConfirmBtn;
  trap.fn({ key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.ok(elements.rotateCancelBtn._focused, 'reverse Tab wraps to last visible confirm control');

  await elements.rotateConfirmBtn.trigger('click');
  elements.rotateCopyBtn._focused = false;
  globalThis.document.activeElement = elements.rotateCloseBtn;
  trap.fn({ key: 'Tab', shiftKey: false, preventDefault() { prevented += 1; } });
  assert.ok(elements.rotateCopyBtn._focused, 'result step traps focus among result controls');
  controller.unbind();
});

test('rotation controller: explicit confirmation, double-click single request, result and error paths', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);

  const elements = makeElements();

  let sends = [];
  let reply = { ok: true, code: 'DABLAJA-A1B2-C3D4-E5F6-G7H8' };
  let delayMs = 0;
  const send = async (msg) => {
    sends.push(msg);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return reply;
  };
  const toasts = [];
  const showToast = (msg, kind) => toasts.push({ msg, kind });
  const clipboard = { async writeText(txt) { clipboard.last = txt; } };

  const controller = createRotationController({ elements, send, clipboard, showToast });
  controller.bind();

  await elements.rotateRecoveryBtn.trigger('click');
  await elements.rotateConfirmBtn.trigger('click');

  assert.equal(sends.length, 1);
  assert.equal(sends[0].type, 'PLUS_ROTATE_RECOVERY');
  assert.ok(elements.rotateConfirmStep.classList.contains('hidden'), 'confirm step hidden on success');
  assert.ok(!elements.rotateResultStep.classList.contains('hidden'), 'result step visible on success');
  assert.equal(elements.rotateResultCode.textContent, 'DABLAJA-A1B2-C3D4-E5F6-G7H8');
  assert.equal(controller.isPending(), false);

  await elements.rotateCloseBtn.trigger('click');
  assert.equal(elements.rotateResultCode.textContent, '', 'code wiped on close dismissal');

  reply = { ok: true, code: 'DABLAJA-SECOND-CALL-XXXXXX' };
  delayMs = 40;
  sends = [];
  await elements.rotateRecoveryBtn.trigger('click');
  const p1 = elements.rotateConfirmBtn.trigger('click');
  const p2 = elements.rotateConfirmBtn.trigger('click');
  await Promise.all([p1, p2]);
  assert.equal(sends.length, 1, 'double-click produced exactly one rotation request');
  await elements.rotateCloseBtn.trigger('click');
  delayMs = 0;

  reply = { ok: false, error: 'انتهت صلاحية الجلسة' };
  await elements.rotateRecoveryBtn.trigger('click');
  await elements.rotateConfirmBtn.trigger('click');

  assert.ok(!elements.rotateStatus.classList.contains('hidden'), 'Arabic status visible on error');
  assert.equal(elements.rotateStatus.textContent, 'انتهت صلاحية الجلسة');
  assert.equal(elements.rotateStatus.style.color, '#C53030');
  assert.equal(elements.rotateConfirmBtn.disabled, false, 'confirm re-enabled on error');
  assert.equal(elements.rotateCancelBtn.disabled, false, 'cancel re-enabled on error');
  assert.equal(elements.rotateResultCode.textContent, '', 'no code on error');
  controller.unbind();
});

test('rotation controller: bind/unbind/rebind does not duplicate requests', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);
  const elements = makeElements();
  let sends = 0;
  const controller = createRotationController({ elements, send: async () => { sends += 1; return { ok: true, code: 'DABLAJA-X' }; }, clipboard: { async writeText() {} }, showToast: () => {} });
  controller.bind();
  controller.unbind();
  controller.bind();
  await elements.rotateRecoveryBtn.trigger('click');
  await elements.rotateConfirmBtn.trigger('click');
  assert.equal(sends, 1, 'rebind did not duplicate listeners');
  controller.unbind();
});

test('rotation controller: clipboard success and failure with Arabic toasts', async (t) => {
  const g = installGlobals(() => {}, () => {});
  t.after(g.restore);

  const elements = makeElements();

  let copied = '';
  let clipboardFail = false;
  const clipboard = {
    async writeText(txt) {
      if (clipboardFail) throw new Error('clipboard unavailable');
      copied = txt;
    }
  };
  const toasts = [];
  const showToast = (msg, kind) => toasts.push({ msg, kind });

  const controller = createRotationController({
    elements,
    send: async () => ({ ok: true, code: 'DABLAJA-CLIPBOARD-12345678' }),
    clipboard,
    showToast
  });
  controller.bind();

  await elements.rotateRecoveryBtn.trigger('click');
  await elements.rotateConfirmBtn.trigger('click');
  assert.equal(elements.rotateResultCode.textContent, 'DABLAJA-CLIPBOARD-12345678');

  await elements.rotateCopyBtn.trigger('click');
  assert.equal(copied, 'DABLAJA-CLIPBOARD-12345678', 'code copied to clipboard');
  assert.ok(toasts.some((r) => r.msg.includes('تم نسخ رمز الاسترداد')), 'success toast shown');

  clipboardFail = true;
  toasts.length = 0;
  await elements.rotateCopyBtn.trigger('click');
  assert.ok(toasts.some((r) => r.msg.includes('تعذر النسخ التلقائي') || r.msg.includes('انسخ الرمز يدوياً')), 'fallback Arabic message shown');

  assert.equal(controller.isPending(), false);
  assert.equal(elements.rotateResultCode.textContent, 'DABLAJA-CLIPBOARD-12345678');
  await elements.rotateCloseBtn.trigger('click');
  assert.equal(elements.rotateResultCode.textContent, '');
  controller.unbind();
});
