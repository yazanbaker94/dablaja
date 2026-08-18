# Kimi K3 Repository Review

## Critical

*None identified.* The core streaming pipeline, memory bounds, and WebAudio graph exhibit strong defense-in-depth with isolated contexts and byte budgets.

---

## High

1. **False API Error on Normal WebSocket Close (`src/shared/protocol.js` & `src/offscreen/offscreen.js`)**
   - **Files:** `src/shared/protocol.js:118`, `src/offscreen/offscreen.js:345`
   - **Why it matters:** When a WebSocket closes with code 1000 (normal closure) carrying a standard reason string (such as `"client stop"`, `"normal closure"`, or proxy close reasons), `classifyConnectionFailure` tests `if (code === 1000 && !text)`. Because `text` is non-empty, the check fails and falls through to `{ kind: 'api_error', transient: false }`. If this occurs during non-stopping state, it triggers a false fatal error toast (`STATUS.ERROR`) instead of a normal/reconnect flow.
   - **Evidence:** `classifyConnectionFailure({ code: 1000, reason: 'client stop' })` returns `{ kind: 'api_error', transient: false }`.
   - **Proposed fix:** Update the condition to `if (code === 1000 || /client stop|normal/.test(text)) return { kind: 'normal', transient: false };`.
   - **Risk:** Very low.
   - **Estimated scope:** 2 lines in `src/shared/protocol.js` + unit tests in `tests/protocol.test.js`.

---

## Medium

1. **AudioContext Closed State Guard in `setGain` (`src/offscreen/offscreen.js`)**
   - **Files:** `src/offscreen/offscreen.js:43`
   - **Why it matters:** If a volume slider message (`SET_VOLUME`) arrives concurrently while the offscreen document is tearing down or closing its `AudioContext`, calling `session.audioContext.currentTime` or `setTargetAtTime` on a detached GainNode can raise an unhandled `InvalidStateError` exception.
   - **Evidence:** `setGain` checks `if (!gainNode || !session?.audioContext) return;` but does not check `session.audioContext.state === 'closed'`.
   - **Proposed fix:** Add `if (!gainNode || !session?.audioContext || session.audioContext.state === 'closed') return;`.
   - **Risk:** None.
   - **Estimated scope:** 1 line.

2. **Pre-roll Buffer Clear on Reconnect (`src/offscreen/offscreen.js`)**
   - **Files:** `src/offscreen/offscreen.js:175`
   - **Why it matters:** When `scheduleReconnect` executes after a connection drop, `session.pendingInput` is retained up to 8 chunks, but `session.preRoll` may contain stale audio captured prior to the connection loss.
   - **Evidence:** `scheduleReconnect` does not call `session.preRoll.clear()`.
   - **Proposed fix:** Explicitly clear `session.preRoll` on socket reconnect setup.
   - **Risk:** Very low.
   - **Estimated scope:** 1 line.

---

## Low

1. **JSDoc and Type Annotations Completeness**
   - **Files:** `src/shared/audio-control.js`, `src/shared/site-profiles.js`
   - **Why it matters:** Type hints improve IDE autocompletion and prevent accidental parameter type mismatches.
   - **Proposed fix:** Standardize JSDoc blocks across shared audio utilities.
   - **Risk:** None.
   - **Estimated scope:** Minor documentation updates.

---

## Potential Features

1. **Visual Audio Level / Waveform Meter in Popup**
   - Render real-time RMS input level and dubbed output level bars in the popup UI to give users immediate feedback that tab capture is functioning before translation starts.
2. **Custom Ducking Ratio Slider in Options**
   - Allow users to configure the auto-ducking attenuation level (currently fixed at 0.32 in `calculateDuckedVolume`).
3. **Downloadable Offline Transcripts with Speaker Diarization**
   - Extend the bilingual transcript exporter to format speaker labels (`spk_1`, `spk_2`) when returned by the Gemini Live transcription service.
