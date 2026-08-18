# Arabic Live Dubbing — System Architecture Audit

**Date:** 2026-08-18  
**Project:** Dablaja (`dablaja@0.3.0`)  
**Type:** Arabic-first Live Dubbing Chrome Extension (Manifest V3)

---

## 1. Main Execution Flow

The real-time audio pipeline captures live tab audio, streams PCM data to Google Gemini Live API via WebSockets, and renders low-latency dubbed Arabic audio with adaptive ducking and buffering.

```text
Tab Media Stream (chrome.tabCapture)
       ↓
Offscreen Document (src/offscreen/offscreen.js)
       ↓
AudioWorklet: capture-processor (src/worklets/capture-processor.js)
  • Downsamples tab audio to 16 kHz Mono PCM
  • Emits 100ms PCM chunks (1,600 samples)
       ↓
Adaptive Noise Gate & VAD (src/shared/audio-control.js)
  • Evaluates RMS vs dynamic noise floor
  • Pre-rolls voice starts / flushes stream end on silence hangover (2000ms)
       ↓
Gemini Live WebSocket (wss://generativelanguage.googleapis.com/.../BidiGenerateContent)
  • Bidirectional real-time translation & TTS streaming
       ↓
Offscreen Message Parser (src/shared/protocol.js)
  • Extracts 24 kHz PCM audio chunks & Arabic / source text captions
       ↓
AudioWorklet: playback-processor (src/worklets/playback-processor.js)
  • Resamples 24 kHz PCM to audioContext sampleRate
  • Adaptive jitter buffer (minimum 280ms, dynamic expand/shrink)
  • Smooth micro-fade envelopes to eliminate click/pop artifacts
       ↓
WebAudio Output Graph
  • Dubbed Gain Node + DynamicsCompressor output limiter
  • Original Tab Gain Node with smooth ducking (timeConstant 0.055s / 0.28s)
       ↓
Audio Destination (Speakers / Headphones)
```

---

## 2. Important Files & Roles

| File | Purpose | Key Classes / Functions | Depends On / Used By |
|---|---|---|---|
| `src/service-worker.js` | MV3 Background Orchestrator. Manages extension lifecycle, tab capture IDs, offscreen doc lifecycle, and Plus drafts. | `startSession`, `stopSession`, `resolveStartTab`, `setState`, `ensureOffscreenDocument` | Used by Popup, Sidepanel, Chrome runtime |
| `src/offscreen/offscreen.js` | WebAudio & WebSocket Manager. Owns AudioContext, getUserMedia stream, Gemini WebSocket, and worklet node messaging. | `startSession`, `connectSocket`, `handleCaptureChunk`, `handleServerObject`, `applyOriginalGain`, `cleanup` | Used by Service Worker |
| `src/worklets/capture-processor.js` | Real-time input audio worklet running on the audio rendering thread. | `CaptureProcessor` (`appendInput`, `process`) | Loaded by `offscreen.js` |
| `src/worklets/playback-processor.js` | Real-time output audio worklet with jitter buffer, drift correction, and click prevention. | `PlaybackProcessor` (`enqueue`, `nextSample`, `process`, `clear`) | Loaded by `offscreen.js` |
| `src/shared/audio-control.js` | Signal processing and buffer management controllers. | `AdaptiveNoiseGate`, `AdaptiveBufferPolicy`, `calculateDuckedVolume` | Used by `offscreen.js` and `playback-processor.js` |
| `src/shared/audio-utils.js` | Pure audio math and buffer converters. | `clampSample`, `floatToPcm16`, `pcm16ToFloat`, `alignPcm16Bytes`, `rmsPcm16`, `BoundedQueue` | Core utility used across worklets and offscreen |
| `src/shared/protocol.js` | Gemini Live API wire protocol builders and parsers. | `buildSetupMessage`, `buildAudioMessage`, `buildAudioStreamEndMessage`, `parseServerMessage`, `classifyConnectionFailure` | Used by `offscreen.js` and test suite |
| `src/shared/constants.js` | System constants, session statuses, storage keys, and initial state factories. | `STATUS`, `STORAGE_KEYS`, `DEFAULTS`, `publicState` | Used project-wide |
| `src/shared/lifecycle.js` | State machine transitions and resource cleanup registry. | `transitionState`, `CleanupRegistry`, `canTransition` | Used by Service Worker and Offscreen |
| `src/shared/plus-draft-controller.js` | Dablaja Plus session recording controller. Tracks segment timestamps, word counts, and bookmark annotations. | `createPlusDraftController` | Used by Service Worker and Library |
| `src/popup/popup.js` | Primary user interface for starting/stopping dubbing, adjusting volumes, and entering Gemini API key. | UI event handlers, state change subscribers | User facing |

---

## 3. Runtime State & Lifecycle

1. **Starting a Session:**
   - User clicks "Start Dubbing" in Popup.
   - `service-worker.js` calls `resolveStartTab` and verifies Gemini API key.
   - `service-worker.js` calls `chrome.tabCapture.getMediaStreamId({ targetTabId })`.
   - `service-worker.js` creates `src/offscreen/offscreen.html` (if not already alive).
   - Offscreen receives `START_SESSION`, opens `getUserMedia` with the `streamId`, instantiates `AudioContext`, loads AudioWorklets, connects the audio graph, and establishes the Gemini WebSocket.

2. **Stopping a Session:**
   - Triggered by user stop button, tab close, navigation away, stream error, or extension reload.
   - `cleanup()` in `offscreen.js` closes WebSocket (`code: 1000`), disconnects all WebAudio nodes, releases media tracks, and closes `AudioContext`.
   - `service-worker.js` persists session duration/metrics in `usage-stats.js`, notifies Plus controller to finalize draft, and transitions state to `STATUS.STOPPED`.

3. **Buffer Management & Drift Correction:**
   - `capture-processor` emits 1600-sample (100ms) chunks to offscreen JS.
   - `playback-processor` maintains an adaptive queue. If queue backlog exceeds 2.5 seconds (e.g. during heavy network burst), it drops excess audio to target 1.2 seconds, resets prebuffer, and notifies offscreen with `BUFFER_RESET` to preserve lip-sync / live context.
