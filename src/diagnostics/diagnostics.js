import { ACTIVE_STATUSES, STATUS } from '../shared/constants.js';

const elements = {
  status: document.querySelector('#status'),
  statusDot: document.querySelector('#statusDot'),
  message: document.querySelector('#message'),
  diagnostic: document.querySelector('#diagnostic'),
  attempt: document.querySelector('#attempt'),
  latency: document.querySelector('#latency'),
  buffer: document.querySelector('#buffer'),
  targetBuffer: document.querySelector('#targetBuffer'),
  underruns: document.querySelector('#underruns'),
  reconnects: document.querySelector('#reconnects'),
  audioSent: document.querySelector('#audioSent'),
  heap: document.querySelector('#heap'),
  retry: document.querySelector('#retry'),
  stop: document.querySelector('#stop'),
  actionError: document.querySelector('#actionError')
};

const labels = {
  [STATUS.NO_KEY]: 'المفتاح مطلوب', [STATUS.READY]: 'جاهز', [STATUS.CONNECTING]: 'جارٍ الاتصال',
  [STATUS.LISTENING]: 'أستمع', [STATUS.TRANSLATING]: 'الترجمة تعمل', [STATUS.RECONNECTING]: 'إعادة الاتصال',
  [STATUS.RATE_LIMITED]: 'حد مؤقت', [STATUS.STOPPED]: 'متوقف', [STATUS.ERROR]: 'خطأ'
};
let state = null;

function render(next) {
  state = next;
  const active = ACTIVE_STATUSES.has(state.status);
  elements.status.textContent = labels[state.status] || state.status;
  elements.message.textContent = state.message || '';
  elements.diagnostic.textContent = state.diagnosticCode || '—';
  elements.attempt.textContent = String(state.reconnectAttempt || 0);
  elements.latency.textContent = state.latencyMs == null ? '—' : `≈${state.latencyMs} ms`;
  elements.buffer.textContent = `${state.outputBufferMs || 0} ms`;
  elements.targetBuffer.textContent = `${state.targetBufferMs || 120} ms`;
  elements.underruns.textContent = String(state.playbackUnderruns || 0);
  elements.reconnects.textContent = String(state.reconnectCount || 0);
  elements.audioSent.textContent = `${Math.round((state.sentAudioMs || 0) / 100) / 10} s`;
  elements.heap.textContent = state.heapEstimateMb == null ? '—' : `≈${state.heapEstimateMb} MB`;
  elements.statusDot.className = active ? 'active' : state.status === STATUS.ERROR ? 'error' : '';
  elements.retry.disabled = active;
  elements.stop.disabled = !active;
}

async function request(type) {
  elements.actionError.textContent = '';
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || 'تعذر تنفيذ الطلب.');
  if (response.state) render(response.state);
}

elements.retry.addEventListener('click', async () => {
  elements.retry.disabled = true;
  try { await request('START_SESSION_FOR_LAST_TAB'); }
  catch (error) { elements.actionError.textContent = error.message; }
  finally { if (!ACTIVE_STATUSES.has(state?.status)) elements.retry.disabled = false; }
});
elements.stop.addEventListener('click', () => request('STOP_SESSION').catch((error) => {
  elements.actionError.textContent = error.message;
}));
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_CHANGED' && message.state) render(message.state);
});
request('GET_STATE').catch((error) => { elements.actionError.textContent = error.message; });
