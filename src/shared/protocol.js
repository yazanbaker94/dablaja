import { API_HOST, API_PATH, MODEL, TARGET_LANGUAGE } from './constants.js';

export function buildWebSocketUrl(apiKey) {
  const url = new URL(`wss://${API_HOST}${API_PATH}`);
  url.searchParams.set('key', apiKey);
  return url.toString();
}

export function buildSetupMessage(resumptionHandle = null) {
  // Primary: official nested shape per current docs (inside generationConfig)
  const setup = {
    model: `models/${MODEL}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode: TARGET_LANGUAGE,
        echoTargetLanguage: false
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    },
    contextWindowCompression: {
      slidingWindow: {}
    },
    sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {}
  };
  return { setup };
}

export function buildLegacySetupMessage(resumptionHandle = null) {
  // Legacy fallback: transcription fields at setup root (observed to work with WSS 1007)
  const setup = {
    model: `models/${MODEL}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode: TARGET_LANGUAGE,
        echoTargetLanguage: false
      }
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: {
      slidingWindow: {}
    },
    sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {}
  };
  return { setup };
}

export function buildAudioMessage(base64Pcm) {
  return {
    realtimeInput: {
      audio: {
        data: base64Pcm,
        mimeType: 'audio/pcm;rate=16000'
      }
    }
  };
}

export function buildAudioStreamEndMessage() {
  return { realtimeInput: { audioStreamEnd: true } };
}

export function parseGoAwayDelayMs(timeLeft) {
  if (timeLeft == null || timeLeft === '') return 0;
  if (typeof timeLeft === 'number' && Number.isFinite(timeLeft)) {
    return timeLeft >= 1000 ? Math.round(timeLeft) : Math.round(timeLeft * 1000);
  }
  if (typeof timeLeft === 'object') {
    const seconds = Number(timeLeft.seconds ?? 0);
    const nanos = Number(timeLeft.nanos ?? 0);
    if (!Number.isFinite(seconds) && !Number.isFinite(nanos)) return 0;
    return Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000 + (Number.isFinite(nanos) ? nanos : 0) / 1e6));
  }
  const text = String(timeLeft).trim();
  const proto = text.match(/^(\d+)(?:\.(\d+))?s$/i);
  if (proto) return Math.round((Number(proto[1]) + (proto[2] ? Number(`0.${proto[2]}`) : 0)) * 1000);
  const millis = text.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
  if (millis) return Math.round(Number(millis[1]));
  return 0;
}

export function pick(object, camel, snake) {
  return object?.[camel] ?? object?.[snake];
}

export function parseServerMessage(raw) {
  const message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const serverContent = pick(message, 'serverContent', 'server_content');
  const parts = pick(serverContent?.modelTurn, 'parts', 'parts') ??
    pick(serverContent?.model_turn, 'parts', 'parts') ?? [];

  const audio = [];
  for (const part of parts) {
    const inline = pick(part, 'inlineData', 'inline_data');
    if (inline?.data) {
      audio.push({ data: inline.data, mimeType: pick(inline, 'mimeType', 'mime_type') ?? '' });
    }
  }

  const inputTranscript = pick(serverContent, 'inputTranscription', 'input_transcription');
  const outputTranscript = pick(serverContent, 'outputTranscription', 'output_transcription');
  const resumption = pick(message, 'sessionResumptionUpdate', 'session_resumption_update');
  const goAway = pick(message, 'goAway', 'go_away');

  return {
    setupComplete: Boolean(pick(message, 'setupComplete', 'setup_complete')),
    audio,
    sourceText: inputTranscript?.text ?? '',
    sourceFinished: Boolean(inputTranscript?.finished),
    sourceSpeaker: pick(inputTranscript, 'speakerLabel', 'speaker_label') ?? '',
    sourceLanguage: pick(inputTranscript, 'languageCode', 'language_code') ?? '',
    targetText: outputTranscript?.text ?? '',
    targetFinished: Boolean(outputTranscript?.finished),
    targetSpeaker: pick(outputTranscript, 'speakerLabel', 'speaker_label') ?? '',
    targetLanguage: pick(outputTranscript, 'languageCode', 'language_code') ?? '',
    resumptionHandle: resumption?.resumable
      ? (pick(resumption, 'newHandle', 'new_handle') ?? null)
      : null,
    goAwayTimeLeft: pick(goAway, 'timeLeft', 'time_left') ?? null,
    interrupted: Boolean(serverContent?.interrupted),
    generationComplete: Boolean(pick(serverContent, 'generationComplete', 'generation_complete'))
  };
}

export function classifyConnectionFailure({ code = 0, reason = '', message = '' } = {}) {
  const text = `${reason} ${message}`.toLowerCase();
  if (code === 429 || /429|quota|rate.?limit|resource.?exhausted/.test(text)) {
    return { kind: 'rate_limited', transient: true };
  }
  if (code === 404 || /404|model.*(not found|unavailable)|not.?found/.test(text)) {
    return { kind: 'model_unavailable', transient: false };
  }
  if ([401, 403, 1008].includes(code) || /api.?key|unauth|permission|401|403|invalid key|revoked|api_key_invalid|expired/.test(text)) {
    return { kind: 'invalid_key', transient: false };
  }
  if (code >= 400 && code < 500) return { kind: 'api_error', transient: false };
  if (code === 1000) return { kind: 'normal', transient: false };
  if ([1001, 1006, 1011, 1012, 1013].includes(code) || (code === 0 && /network|timeout|connection/.test(text))) {
    return { kind: 'network', transient: true };
  }
  return { kind: 'api_error', transient: false };
}
