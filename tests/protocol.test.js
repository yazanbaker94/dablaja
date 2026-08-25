import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudioMessage,
  buildAudioStreamEndMessage,
  buildSetupMessage,
  buildWebSocketUrl,
  classifyConnectionFailure,
  parseGoAwayDelayMs,
  parseServerMessage
} from '../src/shared/protocol.js';

test('setup message uses the verified Live Translate model and Arabic config', () => {
  const { setup } = buildSetupMessage();
  assert.equal(setup.model, 'models/gemini-3.5-live-translate-preview');
  assert.equal(setup.generationConfig.translationConfig.targetLanguageCode, 'ar');
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  // Primary: official nested shape inside generationConfig
  assert.deepEqual(setup.generationConfig.inputAudioTranscription, {});
  assert.deepEqual(setup.generationConfig.outputAudioTranscription, {});
  assert.equal(setup.inputAudioTranscription, undefined);
  assert.equal(setup.outputAudioTranscription, undefined);
  assert.equal(setup.sessionResumption, undefined);
  assert.ok(setup.contextWindowCompression.slidingWindow);
});

test('legacy fallback has root transcription', async () => {
  const { buildLegacySetupMessage } = await import('../src/shared/protocol.js');
  const { setup: legacy } = buildLegacySetupMessage();
  assert.deepEqual(legacy.inputAudioTranscription, {});
  assert.deepEqual(legacy.outputAudioTranscription, {});
  assert.equal(legacy.sessionResumption, undefined);
});

test('WebSocket URL is scoped to the official endpoint and includes provided key', () => {
  const url = new URL(buildWebSocketUrl('placeholder-key-for-test-only'));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.hostname, 'generativelanguage.googleapis.com');
  assert.equal(url.searchParams.get('key'), 'placeholder-key-for-test-only');
});

test('audio message declares PCM at 16 kHz', () => {
  assert.equal(buildAudioMessage('AAAA').realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
});

test('audio stream end flushes the Live API input cache', () => {
  assert.equal(buildAudioStreamEndMessage().realtimeInput.audioStreamEnd, true);
});

test('GoAway delay accepts protobuf duration strings and objects', () => {
  assert.equal(parseGoAwayDelayMs('8s'), 8000);
  assert.equal(parseGoAwayDelayMs('1.5s'), 1500);
  assert.equal(parseGoAwayDelayMs({ seconds: 2, nanos: 500_000_000 }), 2500);
  assert.equal(parseGoAwayDelayMs(0.4), 400);
  assert.equal(parseGoAwayDelayMs(2500), 2500);
  assert.equal(parseGoAwayDelayMs(null), 0);
});

test('parser accepts camelCase server messages', () => {
  const parsed = parseServerMessage({
    setupComplete: {},
    serverContent: {
      inputTranscription: { text: 'hello', languageCode: 'en', finished: true, speakerLabel: 'spk_1' },
      outputTranscription: { text: 'مرحبا', languageCode: 'ar', finished: true },
      modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] }
    }
  });
  assert.equal(parsed.setupComplete, true);
  assert.equal(parsed.sourceText, 'hello');
  assert.equal(parsed.targetText, 'مرحبا');
  assert.equal(parsed.sourceFinished, true);
  assert.equal(parsed.sourceSpeaker, 'spk_1');
  assert.equal(parsed.audio.length, 1);
  assert.equal(parsed.resumptionHandle, undefined);
});

test('parser accepts snake_case server messages', () => {
  const parsed = parseServerMessage({
    server_content: {
      input_transcription: { text: 'source', language_code: 'en' },
      output_transcription: { text: 'الهدف', language_code: 'ar' },
      model_turn: { parts: [{ inline_data: { data: 'BBBB', mime_type: 'audio/pcm;rate=24000' } }] }
    },
    go_away: { time_left: '10s' }
  });
  assert.equal(parsed.sourceLanguage, 'en');
  assert.equal(parsed.targetLanguage, 'ar');
  assert.equal(parsed.goAwayTimeLeft, '10s');
});

test('connection failures distinguish permanent and transient cases', () => {
  assert.deepEqual(classifyConnectionFailure({ code: 1000, reason: '' }), { kind: 'normal', transient: false });
  assert.deepEqual(classifyConnectionFailure({ code: 1000, reason: 'client stop' }), { kind: 'normal', transient: false });
  assert.deepEqual(classifyConnectionFailure({ code: 1000, reason: 'normal closure' }), { kind: 'normal', transient: false });
  assert.deepEqual(classifyConnectionFailure({ code: 1006, reason: 'abnormal closure' }), { kind: 'network', transient: true });
  assert.deepEqual(classifyConnectionFailure({ code: 1008, reason: 'API key invalid' }), { kind: 'invalid_key', transient: false });
  assert.equal(classifyConnectionFailure({ code: 1008, reason: 'API_KEY_INVALID' }).kind, 'invalid_key');
  assert.deepEqual(classifyConnectionFailure({ code: 1013, reason: 'try later' }), { kind: 'network', transient: true });
  assert.equal(classifyConnectionFailure({ reason: '429 resource exhausted' }).kind, 'rate_limited');
  assert.equal(classifyConnectionFailure({ reason: 'model not found 404' }).kind, 'model_unavailable');
  assert.deepEqual(classifyConnectionFailure({ code: 400, reason: 'bad request' }), { kind: 'api_error', transient: false });
});
