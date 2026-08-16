# dablaja — MVP Chrome extension

> **وعد V1:** افهم الفيديوهات والدورات والندوات الإنجليزية مباشرةً بالعربية، بصوت عربي وترجمة ثنائية مباشرة.

Manifest V3 Chrome extension that captures **audio only** from the active tab after an explicit click, sends 100 ms PCM chunks directly to Google's Gemini Live Translate API using the user's own key, plays Arabic audio, and shows source/Arabic transcripts in a side panel.

## Current status

- Core extension, RTL popup, side panel, offscreen audio pipeline, worklets, lifecycle handling, privacy materials, tests, and packaging are implemented.
- Automated checks run with `npm run verify`.
- Real Gemini/API and listening acceptance tests require loading the unpacked extension and entering your own key through its UI. See [TEST_REPORT.md](TEST_REPORT.md) for the current evidence.

## Install unpacked

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select exactly this folder:

   `C:\Users\Yazan\Desktop\Projects\Arabic Live Dubbing`

5. Pin **dablaja** if desired.

## Use

1. Open an ordinary audible HTTPS tab. Initial target: [TED: Inside the mind of a master procrastinator](https://www.youtube.com/watch?v=arj7oStGLkU).
2. Open the extension popup.
3. Paste your own Gemini API key into the masked field, read the disclosure, check the consent box, and save. **Never paste the key into chat, a terminal command, or a bug report.**
4. Click **ابدأ الدبلجة**. Tab capture begins only from this click.
5. Click **فتح الترجمة الثنائية** for persistent source/Arabic captions.
6. Adjust original and dubbed volume independently.
7. Click **إيقاف الدبلجة** when finished. Delete the key from the popup if you no longer want it stored locally.

## Architecture

```text
Popup click
  → MV3 service worker (active tab, state, one-time stream ID)
  → offscreen document (tab MediaStream + AudioContext graph)
      ├─ original GainNode → speakers
      ├─ capture AudioWorklet → mono PCM16/16 kHz/100 ms → Gemini WSS
      └─ playback AudioWorklet ← PCM16/24 kHz ← Gemini → dubbed GainNode → speakers
  → side panel (in-memory source and Arabic captions)
```

The playback worklet resamples 24 kHz output to the device `AudioContext` rate, adapts its prebuffer between 280–520 ms, and absorbs short network jitter as silence instead of stopping and rebuffering. It caps queued audio at 2.5 seconds and drops stale backlog to roughly 1.2 seconds if it grows too large. It fades in after a real gap, limits peaks, and can smoothly duck original audio while Arabic speech plays. The capture path keeps sending through short pauses, then sends `audioStreamEnd` after two seconds of silence and retains 300 ms of in-memory pre-roll.

## Verified API contract (2026-08-11)

The implementation follows Google's official [Live translation guide](https://ai.google.dev/gemini-api/docs/live-api/live-translate):

- Model: `gemini-3.5-live-translate-preview` (preview)
- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- Input: mono raw PCM16 little-endian, 16 kHz, 100 ms (1,600-sample) chunks
- Output: mono raw PCM16 little-endian, 24 kHz
- Target language: `ar`
- Input and output transcription enabled
- `echoTargetLanguage: false`
- Context-window compression and session resumption enabled; `GoAway` triggers a safe reconnect

Google documents roughly ten-minute connection lifetimes and 15-minute uncompressed audio-only session limits. This implementation enables compression and resumption as recommended in the official [session-management guide](https://ai.google.dev/gemini-api/docs/live-api/session-management).

Protocol note: Google's Live Translate page currently shows transcription objects nested in `generationConfig`, while the current official `@google/genai` serializer emits `inputAudioTranscription` and `outputAudioTranscription` directly under `setup`. Live testing rejected the nested shape with WebSocket code 1007, so this implementation follows the official SDK's accepted wire shape: transcription objects at setup level and `translationConfig` inside `generationConfig`.

## Dablaja Plus (local session library — in development)

> **وعد Plus:** «اسمعه بالعربية الآن، واحفظ النص واللحظات المهمة للرجوع إليها.»

Core live dubbing stays free and unchanged. Plus adds a **local-only** saved-session library on top of the transcripts Gemini already returns during a live session:

- Explicit **«احفظ الجلسة»** from the side panel or the library page; optional autosave on stop (default OFF).
- English source + Arabic target transcripts with session-relative timestamps, stored in IndexedDB on this device only.
- Saved-session library with search across Arabic/English transcripts, titles, notes and bookmarks.
- Session notes and timestamped bookmarks (editable, deletable).
- The source URL/title is stored **only when the user explicitly saves** the session.
- Exports: plain text, bilingual SRT, print/PDF, JSON; full local backup + validated import that never corrupts existing data.
- Opt-in per-site volume profiles (hostname only, deletable).
- Up to three recent unsaved drafts survive service-worker suspension in `chrome.storage.session`.

**Privacy boundaries:** no audio is ever stored; no saved-session content (transcripts, notes, bookmarks, URLs, titles) is sent to AudioFetcher or anywhere else; Plus makes no additional Gemini requests; the API key never enters the session database, exports or logs.

**Payment is not connected yet.** Plus currently runs under a clearly labelled `development_preview` entitlement (`src/shared/plus-entitlement.js`) so every feature can be tested locally. The UI shows «نسخة تطوير Plus» and the planned $10-lifetime pricing without claiming purchase availability. A plain local `{ state: "active" }` license record can never unlock production Plus — only the future Stripe-phase verifier pipeline (signed token or the Dablaja entitlement endpoint) can; see the `STRIPE_INTEGRATION_CONTRACT` notes in that module, including cross-device/reinstall recovery, refunds/revocation and offline-grace behavior.

## Security model and important BYOK trade-off

- The key is stored only in `chrome.storage.local`, never sync storage, and is revealed only when the user explicitly presses the show/change control.
- Audio is never written to storage. Captions exist only in extension-page memory; with an entitled Plus session active, a bounded transcript draft (plus temporary title/page URL) may additionally live in `chrome.storage.session` so service-worker suspension does not lose the session — locked/free users get no such draft capture.
- No ads, content scripts, or browsing-history collection. Core/free captions are never stored; the only locally stored page title/URL belongs to an entitled Plus session — temporarily while live, permanently only after an explicit save or enabled autosave.
- Core audio and transcripts go directly to Google; they never pass through the developer server.
- With separate opt-in consent, the extension sends only dubbed duration, a coarse platform category, and bounded technical error diagnostics to `audiofetcher.com`. Declining does not affect dubbing.
- Feedback and uninstall forms are user-submitted and hosted on `audiofetcher.com`.
- No runtime dependency, remote code, `eval`, or inline script.
- Logs intentionally exclude keys, URLs, audio, and transcripts.

Google recommends ephemeral tokens for client-to-server Live API apps. Ephemeral tokens require a provisioning backend. V1 intentionally has no backend and uses a user-owned key, so the API key must be present on the user's device and is placed in the WebSocket authentication URL by the browser, as Google's raw WebSocket protocol requires. Do not use a high-privilege multi-purpose key; create/restrict a dedicated key where Google Cloud controls allow it, and delete it from the extension when not needed.

## Pricing note

The free tier is **not marketed as unlimited**. Availability and rate limits can change. Google's current [Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing) says free-tier Live Translate usage is free of charge and may be used to improve Google's products; paid-tier handling differs. Transcription can add text-token charges. Check the current page before extended use.

## Development and packaging

```powershell
npm run verify        # tests + server tests + static checks + manifest validation
npm run package:dev   # development build (preview entitlement allowed)
npm run package:release  # release build — REFUSES while the preview is enabled
```

`package:dev` re-runs static and manifest checks, copies only runtime files into a clean staging folder, rejects common secret/test/dev artifacts, and creates an unmistakably named build:

`dist\dablaja-v0.3.0-DEVELOPMENT-PREVIEW.zip`

`package:release` additionally enforces manifest/package version parity and fails while `PLUS_DEV_PREVIEW_ENABLED` is true, so a publishable ZIP can never be produced from a preview build. It does not publish or upload anything.

Regenerate toolbar and page icons from `design images/logo toolbar.png` (cropped, transparency kept) with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
```

## Known V1 constraints

- Preview-model availability, geography, quota, pricing, and behavior are controlled by Google.
- The observed-latency badge is a local diagnostic from detected source activity to the first returned audio after it; it is approximate, not an end-to-end guarantee.
- Silence gating uses an energy threshold and may treat quiet speech as pause or music as activity.
- Automated browser checks cannot assess audio quality. A human must confirm audibility, balance, delay, and absence of severe crackling/overlap.
- Chrome internal pages, the Chrome Web Store, local browser UI pages, DRM-restricted media, and tabs without audible audio may not be capturable.

See [PRIVACY.md](PRIVACY.md), [TEST_PLAN.md](TEST_PLAN.md), [TEST_REPORT.md](TEST_REPORT.md), and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
