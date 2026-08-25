// Recovery-code rotation controller, extracted from library.js into an
// importable dependency-injected module so tests exercise the real
// implementation rather than a copy.

export function createRotationController({
  elements = {},
  send = async () => null,
  clipboard = null,
  showToast = () => {},
  focusElement = null
} = {}) {
  let rotatePending = false;
  let previousFocus = null;
  let unloadHandler = null;
  let trapHandler = null;
  let boundHandlers = null;

  function isOpen() {
    return !elements.rotateRecoveryModal?.classList.contains('hidden');
  }

  function openModal() {
    try {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      previousFocus = activeEl && typeof activeEl.focus === 'function' ? activeEl : (focusElement || null);
    } catch {
      previousFocus = focusElement || null;
    }
    if (elements.rotateStatus) {
      elements.rotateStatus.textContent = '';
      elements.rotateStatus.classList.add('hidden');
    }
    if (elements.rotateResultCode) {
      elements.rotateResultCode.textContent = '';
    }
    elements.rotateConfirmStep?.classList.remove('hidden');
    elements.rotateResultStep?.classList.add('hidden');
    if (elements.rotateConfirmBtn) elements.rotateConfirmBtn.disabled = false;
    if (elements.rotateCancelBtn) elements.rotateCancelBtn.disabled = false;
    elements.rotateRecoveryModal?.classList.remove('hidden');
    if (elements.rotateConfirmBtn?.focus) elements.rotateConfirmBtn.focus();
  }

  function closeModal() {
    if (rotatePending) return;
    doClose();
  }

  function doClose() {
    elements.rotateRecoveryModal?.classList.add('hidden');
    if (elements.rotateResultCode) {
      elements.rotateResultCode.textContent = '';
    }
    if (elements.rotateStatus) {
      elements.rotateStatus.textContent = '';
      elements.rotateStatus.classList.add('hidden');
    }
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try {
        previousFocus.focus();
      } catch {}
    }
    previousFocus = null;
  }

  function handleEscape(event) {
    if (event.key === 'Escape') closeModal();
  }

  function handleDocumentEscape(event) {
    if (event.key === 'Escape' && isOpen()) {
      closeModal();
    }
  }

  function handleFocusTrap(event) {
    if (!isOpen() || event.key !== 'Tab') return;
    // Do not include controls inside the currently hidden modal step. Calling
    // focus() on a display:none result button would let Shift+Tab escape the
    // dialog in real Chrome even though basic DOM mocks consider it focusable.
    const focusables = [];
    if (!elements.rotateConfirmStep?.classList.contains('hidden')) {
      focusables.push(elements.rotateConfirmBtn, elements.rotateCancelBtn);
    }
    if (!elements.rotateResultStep?.classList.contains('hidden')) {
      focusables.push(elements.rotateCopyBtn, elements.rotateCloseBtn);
    }
    const visibleFocusables = focusables.filter((el) => el && typeof el.focus === 'function' && !el.disabled);
    if (visibleFocusables.length === 0) return;
    const first = visibleFocusables[0];
    const last = visibleFocusables[visibleFocusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleConfirm() {
    if (rotatePending) return;
    rotatePending = true;
    if (elements.rotateConfirmBtn) elements.rotateConfirmBtn.disabled = true;
    if (elements.rotateCancelBtn) elements.rotateCancelBtn.disabled = true;
    if (elements.rotateStatus) elements.rotateStatus.classList.add('hidden');
    let networkAmbiguous = false;
    try {
      const res = await send({ type: 'PLUS_ROTATE_RECOVERY' });
      if (!res?.ok || !res?.code) {
        throw new Error(res?.error || 'تعذر توليد رمز استرداد بديل. تأكد من تفعيل الترخيص.');
      }
      elements.rotateConfirmStep?.classList.add('hidden');
      elements.rotateResultStep?.classList.remove('hidden');
      if (elements.rotateResultCode) {
        elements.rotateResultCode.textContent = res.code;
      }
      if (elements.rotateCloseBtn?.focus) elements.rotateCloseBtn.focus();
    } catch (e) {
      const msg = e?.message || '';
      const isNetwork = /network|fetch|Failed to fetch|Load failed|اتصال/i.test(msg);
      if (isNetwork) networkAmbiguous = true;
      if (elements.rotateStatus) {
        if (networkAmbiguous) {
          elements.rotateStatus.textContent = 'تعذر التأكد من اكتمال التدوير بسبب الشبكة. حاول إعادة التدوير — سيُنشأ رمز جديد صالح.';
        } else {
          elements.rotateStatus.textContent = msg || 'تعذر توليد رمز استرداد بديل. حاول لاحقاً.';
        }
        elements.rotateStatus.classList.remove('hidden');
        elements.rotateStatus.style.color = '#C53030';
      }
      if (elements.rotateConfirmBtn) elements.rotateConfirmBtn.disabled = false;
      if (elements.rotateCancelBtn) elements.rotateCancelBtn.disabled = false;
    } finally {
      rotatePending = false;
    }
  }

  async function handleCopy() {
    const code = elements.rotateResultCode?.textContent?.trim();
    if (!code) return;
    try {
      await (clipboard || (globalThis.navigator && navigator.clipboard)).writeText(code);
      showToast('تم نسخ رمز الاسترداد بنجاح.', 'info');
    } catch {
      showToast('تعذر النسخ التلقائي. انسخ الرمز يدوياً.', 'error');
    }
  }

  function bind() {
    if (boundHandlers) return;
    const h = {};
    h.open = openModal;
    h.cancel = closeModal;
    h.close = closeModal;
    h.confirm = handleConfirm;
    h.copy = handleCopy;
    boundHandlers = h;
    if (elements.rotateRecoveryBtn) {
      elements.rotateRecoveryBtn.addEventListener('click', h.open);
    }
    if (elements.rotateCancelBtn) {
      elements.rotateCancelBtn.addEventListener('click', h.cancel);
    }
    if (elements.rotateCloseBtn) {
      elements.rotateCloseBtn.addEventListener('click', h.close);
    }
    if (elements.rotateConfirmBtn) {
      elements.rotateConfirmBtn.addEventListener('click', h.confirm);
    }
    if (elements.rotateCopyBtn) {
      elements.rotateCopyBtn.addEventListener('click', h.copy);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', handleDocumentEscape);
      trapHandler = handleFocusTrap;
      document.addEventListener('keydown', trapHandler);
    }
    unloadHandler = (event) => {
      if (rotatePending) {
        if (event) {
          try { event.preventDefault?.(); } catch {}
          try { event.returnValue = ''; } catch {}
        }
        return '';
      }
      try {
        if (elements.rotateResultCode) elements.rotateResultCode.textContent = '';
      } catch {}
    };
    if (typeof window !== 'undefined') {
      try {
        window.addEventListener('beforeunload', unloadHandler);
      } catch {}
    }
  }

  function unbind() {
    if (!boundHandlers) return;
    const h = boundHandlers;
    if (elements.rotateRecoveryBtn) {
      try { elements.rotateRecoveryBtn.removeEventListener('click', h.open); } catch {}
    }
    if (elements.rotateCancelBtn) {
      try { elements.rotateCancelBtn.removeEventListener('click', h.cancel); } catch {}
    }
    if (elements.rotateCloseBtn) {
      try { elements.rotateCloseBtn.removeEventListener('click', h.close); } catch {}
    }
    if (elements.rotateConfirmBtn) {
      try { elements.rotateConfirmBtn.removeEventListener('click', h.confirm); } catch {}
    }
    if (elements.rotateCopyBtn) {
      try { elements.rotateCopyBtn.removeEventListener('click', h.copy); } catch {}
    }
    boundHandlers = null;
    if (unloadHandler && typeof window !== 'undefined') {
      try {
        window.removeEventListener('beforeunload', unloadHandler);
      } catch {}
      unloadHandler = null;
    }
    if (trapHandler && typeof document !== 'undefined') {
      try {
        document.removeEventListener('keydown', handleDocumentEscape);
      } catch {}
      try {
        document.removeEventListener('keydown', trapHandler);
      } catch {}
      trapHandler = null;
    } else if (typeof document !== 'undefined') {
      try {
        document.removeEventListener('keydown', handleDocumentEscape);
      } catch {}
    }
  }

  function isPending() {
    return rotatePending;
  }

  function _forceCloseForTest() {
    doClose();
  }

  return {
    openModal,
    closeModal,
    bind,
    unbind,
    isPending,
    isOpen,
    _handleConfirm: handleConfirm,
    _handleCopy: handleCopy,
    _handleEscape: handleEscape,
    _forceCloseForTest
  };
}
