import {
  INPUT_CHUNK_MS,
  STATUS,
  publicState
} from '../shared/constants.js';
import {
  buildAudioMessage,
  buildAudioStreamEndMessage,
  buildLegacySetupMessage,
  buildSetupMessage,
  buildWebSocketUrl,
  classifyConnectionFailure,
  parseGoAwayDelayMs,
  parseServerMessage
} from '../shared/protocol.js';
import {
  BoundedQueue,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  rmsPcm16
} from '../shared/audio-utils.js';
import { CleanupRegistry } from '../shared/lifecycle.js';
import { AdaptiveNoiseGate, calculateDuckedVolume } from '../shared/audio-control.js';

const SILENCE_THRESHOLD = 0.0025;
const SILENCE_HANGOVER_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 8;
const SAFE_CLOSE_CODE = 1000;
const MAX_FLUSH_CHUNKS = 5;

let session = null;

function notify(message) {
  return chrome.runtime.sendMessage({ source: 'offscreen', ...message }).catch(() => undefined);
}

function statePatch(patch) {
  if (!session) return;
  session.state = { ...session.state, ...patch };
  notify({ type: 'OFFSCREEN_STATE', state: session.state });
}

function setGain(gainNode, value) {
  if (!gainNode || !session?.audioContext) return;
  if (session.audioContext.state === 'closed') return;
  const safe = Math.max(0, Math.min(1.5, Number(value) || 0));
  gainNode.gain.cancelScheduledValues(session.audioContext.currentTime);
  gainNode.gain.setTargetAtTime(safe, session.audioContext.currentTime, 0.015);
}

function applyOriginalGain(playbackActive = session?.playbackActive) {
  if (!session?.originalGain || !session.audioContext) return;
  session.playbackActive = Boolean(playbackActive);
  const target = calculateDuckedVolume(
    session.originalBaseVolume,
    session.autoDucking,
    session.playbackActive
  );
  const timeConstant = session.playbackActive ? 0.055 : 0.28;
  session.originalGain.gain.cancelScheduledValues(session.audioContext.currentTime);
  session.originalGain.gain.setTargetAtTime(target, session.audioContext.currentTime, timeConstant);
}

function closeSocket(socket) {
  if (!socket) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) {
    socket.close(SAFE_CLOSE_CODE, 'client stop');
  }
}

async function cleanup({ preserveSession = false } = {}) {
  const current = session;
  if (!current) return;
  current.stopping = true;
  clearTimeout(current.reconnectTimer);
  clearTimeout(current.errorWatchdog);
  clearTimeout(current.setupRetryTimer);
  current.reconnectTimer = null;
  current.errorWatchdog = null;
  current.setupRetryTimer = null;
  closeSocket(current.socket);
  current.socket = null;
  current.ready = false;
  current.streamEnded = false;
  current.goAwayScheduled = false;
  current.pendingInput.clear();
  current.preRoll.clear();
  try { current.playbackNode?.port.postMessage({ type: 'CLEAR' }); } catch { }
  if (current.captureNode?.port) current.captureNode.port.onmessage = null;
  if (current.playbackNode?.port) current.playbackNode.port.onmessage = null;
  try { current.captureNode?.port.close(); } catch { }
  try { current.playbackNode?.port.close(); } catch { }
  try { current.sourceNode?.disconnect(); } catch { }
  try { current.captureNode?.disconnect(); } catch { }
  try { current.captureMute?.disconnect(); } catch { }
  try { current.originalGain?.disconnect(); } catch { }
  try { current.playbackNode?.disconnect(); } catch { }
  try { current.dubbedGain?.disconnect(); } catch { }
  try { current.outputLimiter?.disconnect(); } catch { }
  await current.resources?.dispose();
  current.apiKey = '';
  notify({ type: 'CAPTION', clear: true });
  if (!preserveSession) session = null;
}

async function fatal(status, message, diagnosticCode = null, errorKind = null) {
  const finalState = session
    ? { ...session.state, status, message, diagnosticCode, sourcePaused: false, outputBufferMs: 0 }
    : publicState({ status, message, diagnosticCode });
  await cleanup();
  await notify({ type: 'OFFSCREEN_FATAL', status, message, diagnosticCode, errorKind, state: finalState });
}

function flushPendingInput() {
  if (!session?.ready || session.socket?.readyState !== WebSocket.OPEN) return;
  while (session.pendingInput.length > MAX_FLUSH_CHUNKS) session.pendingInput.shift();
  while (session.pendingInput.length) sendPcm(session.pendingInput.shift());
}

function sendAudioStreamEnd() {
  if (!session?.ready || session.socket?.readyState !== WebSocket.OPEN || session.streamEnded) return;
  session.socket.send(JSON.stringify(buildAudioStreamEndMessage()));
  session.streamEnded = true;
}

function sendPcm(buffer) {
  if (!session || !buffer) return;
  if (!session.ready || session.socket?.readyState !== WebSocket.OPEN) {
    session.pendingInput.push(buffer);
    return;
  }
  const payload = buildAudioMessage(arrayBufferToBase64(buffer));
  session.socket.send(JSON.stringify(payload));
  session.lastInputSentAt = performance.now();
  session.sentAudioMs += INPUT_CHUNK_MS;
}

function handleCaptureChunk(buffer) {
  if (!session || session.stopping) return;
  const now = performance.now();
  const pcm = new Int16Array(buffer);
  const rms = rmsPcm16(pcm);
  const gate = session.noiseGate.update(rms);
  const speech = rms >= Math.max(SILENCE_THRESHOLD * 0.5, gate.threshold);

  if (speech) {
    if (session.sourcePaused) {
      session.sourcePaused = false;
      session.streamEnded = false;
      session.voiceStartedAt = now;
      statePatch({ sourcePaused: false, status: session.ready ? STATUS.LISTENING : session.state.status });
      while (session.preRoll.length) sendPcm(session.preRoll.shift());
    }
    session.lastVoiceAt = now;
    sendPcm(buffer);
    return;
  }

  if (now - session.lastVoiceAt <= SILENCE_HANGOVER_MS) {
    sendPcm(buffer);
  } else {
    session.preRoll.push(buffer);
    if (!session.sourcePaused) {
      session.sourcePaused = true;
      sendAudioStreamEnd();
      statePatch({ sourcePaused: true, status: session.ready ? STATUS.LISTENING : session.state.status });
    }
  }
}

function scheduleReconnect(failure, immediate = false) {
  if (!session || session.stopping) return;
  if (session.reconnectTimer && !session.goAwayScheduled) return;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    session.goAwayScheduled = false;
  }
  session.ready = false;
  session.streamEnded = false;
  closeSocket(session.socket);
  session.socket = null;
  session.preRoll.clear();
  session.reconnectAttempt += 1;
  session.reconnectCount += 1;
  if (session.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    fatal(STATUS.ERROR, 'تعذر استعادة الاتصال بعد عدة محاولات. تحقق من الشبكة وحاول مجدداً.', null, 'network_error');
    return;
  }

  const delay = immediate ? 250 : Math.min(15_000, 750 * (2 ** (session.reconnectAttempt - 1)));
  const status = failure.kind === 'rate_limited' ? STATUS.RATE_LIMITED : STATUS.RECONNECTING;
  const message = failure.kind === 'rate_limited'
    ? 'بلغت الخدمة حد المعدل مؤقتاً. ستتم إعادة المحاولة تلقائياً.'
    : 'انقطع الاتصال مؤقتاً. جارٍ إعادة الاتصال…';
  statePatch({
    status,
    message,
    reconnectAttempt: session.reconnectAttempt,
    reconnectCount: session.reconnectCount
  });
  const reconnectOwner = session;
  reconnectOwner.reconnectTimer = setTimeout(() => {
    if (session !== reconnectOwner || reconnectOwner.stopping) return;
    reconnectOwner.reconnectTimer = null;
    connectSocket();
  }, delay);
}

function scheduleGoAwayReconnect(delayMs) {
  if (!session || session.stopping || session.reconnectTimer || session.goAwayScheduled) return;
  session.goAwayScheduled = true;
  const wait = Math.max(250, delayMs);
  const reconnectOwner = session;
  reconnectOwner.reconnectTimer = setTimeout(() => {
    if (session !== reconnectOwner || reconnectOwner.stopping) return;
    reconnectOwner.reconnectTimer = null;
    reconnectOwner.goAwayScheduled = false;
    scheduleReconnect({ kind: 'network', transient: true }, true);
  }, wait);
}

function handleConnectionFailure(details) {
  if (!session || session.stopping) return;
  const failure = classifyConnectionFailure(details);
  const diagnosticCode = details.source === 'server'
    ? `API ${details.code || '?'}${details.apiStatus ? ` ${details.apiStatus}` : ''}`
    : `WSS ${details.code || '?'}`;
  if (failure.kind === 'normal') {
    scheduleReconnect({ kind: 'network', transient: true });
  } else if (failure.kind === 'invalid_key') {
    fatal(STATUS.ERROR, 'رفضت Google مفتاح Gemini. غيّر المفتاح أو تأكد من تفعيله.', diagnosticCode, 'api_key_invalid');
  } else if (failure.kind === 'model_unavailable') {
    fatal(STATUS.ERROR, 'نموذج الترجمة المباشرة غير متاح لهذا المفتاح أو المنطقة حالياً.', diagnosticCode, 'model_unavailable');
  } else if (failure.transient) {
    scheduleReconnect(failure);
  } else {
    const reasonText = String(details.reason || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    fatal(
      STATUS.ERROR,
      `رفضت Gemini إعداد الجلسة (${diagnosticCode}${reasonText ? `: ${reasonText}` : ''}).`,
      diagnosticCode,
      'setup_failed'
    );
  }
}

function handleServerObject(object) {
  if (!session || session.stopping) return;
  if (object?.error) {
    handleConnectionFailure({
      code: Number(object.error.code) || 0,
      message: `${object.error.code ?? ''} ${object.error.status ?? ''} ${object.error.message ?? ''}`,
      apiStatus: String(object.error.status || '').replace(/[^A-Z_]/g, '').slice(0, 40),
      source: 'server'
    });
    return;
  }

  const parsed = parseServerMessage(object);
  if (parsed.setupComplete) {
    session.ready = true;
    session.reconnectAttempt = 0;
    session.streamEnded = false;
    session.goAwayScheduled = false;
    statePatch({
      status: STATUS.LISTENING,
      message: session.sourcePaused ? 'متصل — المصدر صامت أو متوقف مؤقتاً.' : 'أستمع إلى صوت التبويب…',
      reconnectAttempt: 0
    });
    flushPendingInput();
  }
  if (parsed.sourceText || parsed.sourceFinished) {
    notify({
      type: 'CAPTION',
      channel: 'source',
      text: parsed.sourceText,
      turnId: session.captionTurnId,
      language: parsed.sourceLanguage,
      speaker: parsed.sourceSpeaker,
      final: parsed.sourceFinished
    });
  }
  if (parsed.targetText || parsed.targetFinished) {
    notify({
      type: 'CAPTION',
      channel: 'target',
      text: parsed.targetText,
      turnId: session.captionTurnId,
      language: parsed.targetLanguage || 'ar',
      speaker: parsed.targetSpeaker,
      final: parsed.targetFinished
    });
  }

  if (parsed.audio.length) {
    if (session.voiceStartedAt) {
      const latencyMs = Math.round(performance.now() - session.voiceStartedAt);
      session.voiceStartedAt = 0;
      statePatch({ latencyMs });
    }
    statePatch({ status: STATUS.TRANSLATING, message: 'الدبلجة العربية تعمل الآن…' });
    for (const item of parsed.audio) {
      const buffer = base64ToArrayBuffer(item.data);
      session.playbackNode.port.postMessage({ type: 'ENQUEUE', buffer }, [buffer]);
    }
  } else if (parsed.generationComplete && session.ready) {
    statePatch({ status: STATUS.LISTENING, message: 'أستمع إلى صوت التبويب…' });
  }

  if (parsed.generationComplete || parsed.interrupted) {
    session.captionTurnId += 1;
  }

  if (parsed.goAwayTimeLeft) {
    const remainingMs = parseGoAwayDelayMs(parsed.goAwayTimeLeft);
    if (remainingMs > 1500) scheduleGoAwayReconnect(remainingMs - 400);
    else scheduleReconnect({ kind: 'network', transient: true }, true);
  }
}

function connectSocket() {
  if (!session || session.stopping) return;
  statePatch({
    status: session.reconnectAttempt ? STATUS.RECONNECTING : STATUS.CONNECTING,
    message: session.reconnectAttempt ? 'جارٍ إعادة الاتصال بـ Gemini…' : 'جارٍ الاتصال بـ Gemini…'
  });

  const socket = new WebSocket(buildWebSocketUrl(session.apiKey));
  session.socket = socket;
  const socketOwner = session;
  // Do NOT reset the setup-shape selector here: the one-shot 1007 fallback
  // flips setupPrimary before reconnecting and this function must keep that
  // choice for the retry (and all later reconnects of this session).
  if (session.setupPrimary == null) session.setupPrimary = true;
  if (session.setupRetryUsed == null) session.setupRetryUsed = false;
  socket.onopen = () => {
    if (session !== socketOwner || socketOwner.stopping || socketOwner.socket !== socket) return;
    // Start every connection as a fresh translation session. Deliberately do
    // not configure Gemini session resumption: Google documents that generated
    // resumption handles can retain live conversation state for up to 24 hours.
    const msg = socketOwner.setupPrimary ? buildSetupMessage() : buildLegacySetupMessage();
    socket.send(JSON.stringify(msg));
    // Record which shape was sent for diagnostics (no key/WSS URL logged)
    socketOwner.lastSetupShape = socketOwner.setupPrimary ? 'primary_nested' : 'legacy_root';
  };
  socket.onmessage = async (event) => {
    if (session !== socketOwner || socketOwner.stopping || socketOwner.socket !== socket) return;
    try {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      if (session !== socketOwner || socketOwner.stopping || socketOwner.socket !== socket) return;
      handleServerObject(JSON.parse(raw));
    } catch {
      handleConnectionFailure({ code: 1011, message: 'invalid server response' });
    }
  };
  socket.onerror = () => {
    if (session !== socketOwner || socketOwner.stopping || socketOwner.socket !== socket) return;
    clearTimeout(socketOwner.errorWatchdog);
    socketOwner.errorWatchdog = setTimeout(() => {
      if (session === socketOwner && !socketOwner.stopping && socketOwner.socket === socket) {
        handleConnectionFailure({ code: 1006, message: 'network error' });
      }
    }, 1500);
  };
  socket.onclose = (event) => {
    if (session !== socketOwner || socketOwner.stopping || socketOwner.socket !== socket) return;
    clearTimeout(socketOwner.errorWatchdog);
    socketOwner.errorWatchdog = null;
    // Single compatibility retry for setup rejection 1007: flip to the other
    // transcription-field layout (root <-> nested generationConfig) once.
    if (event.code === 1007 && !socketOwner.setupRetryUsed) {
      socketOwner.setupRetryUsed = true;
      socketOwner.setupPrimary = !socketOwner.setupPrimary;
      // Record safe diagnostic: code + new shape, no key/WSS URL
      socketOwner.lastSetupRetry = { code: event.code, shape: socketOwner.setupPrimary ? 'primary_nested' : 'legacy_root', at: Date.now() };
      closeSocket(socket);
      // Reconnect with the flipped shape once
      const retryOwner = socketOwner;
      retryOwner.setupRetryTimer = setTimeout(() => {
        if (session !== retryOwner || retryOwner.stopping) return;
        retryOwner.setupRetryTimer = null;
        connectSocket();
      }, 250);
      return;
    }
    handleConnectionFailure({ code: event.code, reason: event.reason, source: 'socket' });
  };
}

async function startSession(message) {
  if (session) await cleanup();
  let startPhase = 'tab_stream';
  const audioContext = new AudioContext({ latencyHint: 'interactive' });
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId
        }
      },
      video: false
    });
    startPhase = 'worklet_modules';
    await Promise.all([
      audioContext.audioWorklet.addModule('../worklets/capture-processor.js'),
      audioContext.audioWorklet.addModule('../worklets/playback-processor.js')
    ]);
    startPhase = 'audio_graph';
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const originalGain = audioContext.createGain();
    const dubbedGain = audioContext.createGain();
    const outputLimiter = audioContext.createDynamicsCompressor();
    const captureNode = new AudioWorkletNode(audioContext, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: 'max'
    });
    const captureMute = audioContext.createGain();
    const playbackNode = new AudioWorkletNode(audioContext, 'playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });

    session = {
      apiKey: message.apiKey,
      tabId: message.tabId,
      audioContext,
      stream,
      sourceNode,
      originalGain,
      dubbedGain,
      outputLimiter,
      captureNode,
      captureMute,
      playbackNode,
      socket: null,
      ready: false,
      stopping: false,
      reconnectTimer: null,
      errorWatchdog: null,
      setupRetryTimer: null,
      reconnectAttempt: 0,
      pendingInput: new BoundedQueue(8),
      preRoll: new BoundedQueue(3),
      streamEnded: false,
      goAwayScheduled: false,
      lastVoiceAt: performance.now(),
      lastInputSentAt: 0,
      sentAudioMs: 0,
      reconnectCount: 0,
      voiceStartedAt: performance.now(),
      captionTurnId: 0,
      sourcePaused: false,
      noiseGate: new AdaptiveNoiseGate(),
      // Setup-shape selection: starts on the ROOT-field transcription shape
      // (what gemini-3.5-live-translate-preview accepts); a single 1007
      // compatibility rejection flips to the nested-generationConfig shape
      // for the retry, covering models that expect the older layout.
      setupPrimary: false,
      setupRetryUsed: false,
      originalBaseVolume: Math.max(0, Math.min(1.5, Number(message.originalVolume) || 0)),
      autoDucking: message.autoDucking !== false,
      playbackActive: false,
      resources: new CleanupRegistry(),
      state: publicState({
        status: STATUS.CONNECTING,
        message: 'جارٍ تهيئة الصوت…',
        tabId: message.tabId,
        startedAt: Date.now()
      })
    };

    session.resources.add(async () => {
      if (audioContext.state !== 'closed') await audioContext.close();
    });
    session.resources.add(() => {
      for (const track of stream.getTracks()) track.stop();
    });

    originalGain.gain.value = session.originalBaseVolume;
    dubbedGain.gain.value = Math.max(0, Math.min(1.5, Number(message.dubbedVolume) || 0));
    outputLimiter.threshold.value = -3;
    outputLimiter.knee.value = 5;
    outputLimiter.ratio.value = 12;
    outputLimiter.attack.value = 0.003;
    outputLimiter.release.value = 0.16;
    sourceNode.connect(originalGain).connect(audioContext.destination);
    captureMute.gain.value = 0;
    sourceNode.connect(captureNode).connect(captureMute).connect(audioContext.destination);
    playbackNode.connect(dubbedGain).connect(outputLimiter).connect(audioContext.destination);

    const callbackOwner = session;
    captureNode.port.onmessage = ({ data }) => {
      if (session !== callbackOwner || callbackOwner.stopping) return;
      if (data?.type === 'PCM_CHUNK' && data.buffer) handleCaptureChunk(data.buffer);
    };
    playbackNode.port.onmessage = ({ data }) => {
      if (session !== callbackOwner || callbackOwner.stopping) return;
      if (data?.type === 'BUFFER_STATUS') {
        const heapEstimateMb = Number.isFinite(performance.memory?.usedJSHeapSize)
          ? Math.round(performance.memory.usedJSHeapSize / 1048576)
          : null;
        statePatch({
          outputBufferMs: data.bufferMs,
          targetBufferMs: data.targetBufferMs,
          playbackUnderruns: data.underruns,
          playbackActive: data.playing,
          sentAudioMs: session.sentAudioMs,
          reconnectCount: session.reconnectCount,
          heapEstimateMb
        });
      }
      if (data?.type === 'PLAYBACK_ACTIVE') {
        applyOriginalGain(data.active);
        statePatch({ playbackActive: data.active });
      }
      if (data?.type === 'BUFFER_RESET') {
        statePatch({ message: 'تم تصحيح تراكم في مخزن الصوت لتقليل التأخير.' });
      }
    };
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (session === callbackOwner && !callbackOwner.stopping) {
          fatal(STATUS.ERROR, 'توقف التقاط صوت التبويب. ابدأ جلسة جديدة.', null, 'audio_capture_failed');
        }
      }, { once: true });
    }

    await audioContext.resume();
    startPhase = 'gemini_socket';
    connectSocket();
  } catch (error) {
    for (const track of stream?.getTracks() ?? []) track.stop();
    await audioContext.close().catch(() => undefined);
    const safeError = new Error(startPhase);
    safeError.cause = error;
    throw safeError;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (message.type === 'START_SESSION') {
    startSession(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const phaseMessages = {
          tab_stream: 'تعذر الوصول إلى صوت التبويب.',
          worklet_modules: 'تعذر تحميل معالجات الصوت المحلية.',
          audio_graph: 'تعذر تهيئة مسار تشغيل الصوت.',
          gemini_socket: 'تعذر بدء الاتصال بخدمة Gemini.'
        };
        sendResponse({
          ok: false,
          error: phaseMessages[error?.message] || 'تعذر تهيئة معالجة صوت التبويب.'
        });
      });
    return true;
  }
  if (message.type === 'STOP_SESSION') {
    cleanup().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'SET_VOLUME') {
    if (message.kind === 'original' && session) {
      session.originalBaseVolume = Math.max(0, Math.min(1.5, Number(message.value) || 0));
      applyOriginalGain();
    }
    if (message.kind === 'dubbed') setGain(session?.dubbedGain, message.value);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'SET_AUTO_DUCKING') {
    if (session) {
      session.autoDucking = message.enabled === true;
      applyOriginalGain();
    }
    sendResponse({ ok: true });
    return false;
  }
  sendResponse({ ok: false });
  return false;
});
