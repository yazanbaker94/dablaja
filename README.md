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
3. Paste your own Gemini API key into the masked field, read the disclosure beside it, and save. **Never paste the key into chat, a terminal command, or a bug report.**
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

Protocol note: Google's Live Translate page currently shows transcription objects nested in `generationConfig`, while the current official `@google/genai` serializer emits `inputAudioTranscription` and `outputAudioTranscription` directly under `setup`. Live testing rejected the nested shape with WebSocket code 1007. The extension therefore starts with the field-tested root transcription shape and performs one bounded 1007 compatibility retry using the documented nested shape; it never loops between setup layouts.

## Dablaja Plus (local session library)

> **وعد Plus:** «اسمعه بالعربية الآن، واحفظ النص واللحظات المهمة للرجوع إليها.»

Core live dubbing is available to all users. Dablaja provides a **local-only** session library on top of the transcripts Gemini returns during live dubbing:

- Local session saving is enabled by default and can be disabled from the Plus library without affecting live dubbing. Free users may save one session, one bookmark, and one site profile.
- Plus users can save up to 500 sessions, 100 bookmarks per session, and 50 site profiles.
- Audio is never stored anywhere on any device or server.
- Saved transcripts, titles, and URLs remain strictly local on your device in IndexedDB.
- **«احفظ الجلسة»** saves a recoverable live draft immediately. On stop, the first free session or a verified Plus session is finalized locally; disabling local saving prevents new draft/session storage.
- Session notes and timestamped bookmarks (editable, deletable).
- Exports: plain text, bilingual SRT, print/PDF, JSON; full local backup + validated import that never corrupts existing data.
- Opt-in per-site volume profiles (hostname only, deletable).
- Up to three recent unsaved drafts survive service-worker suspension in `chrome.storage.session`.

**Payment via Stripe Checkout (10$ one-time).** Plus is unlocked only by a verified Ed25519 signed token (`dpl1.<payload>.<sig>`) bound to the current `install_id` with 30-day expiry and 7-day offline grace. Every privileged licensing request (checkout, license-status, token renewal, recovery, rotation) is authenticated with a high-entropy per-installation credential (256-bit random) stored in `chrome.storage.local`. A plain local `{ state: "active" }` record never unlocks Plus. Stripe handles payment-card data; Dablaja does not receive or store card numbers. Licensing data retained by AudioFetcher is strictly limited to: random installation identifier (`install_id`), hashed installation credential (`credential_hash`), stable internal license identifier (`license_id`), Stripe reference identifiers, product/price IDs, amount/currency/status, bindings, timestamps, revocation state, and hashed recovery code (`code_hash`). Recovery codes are shown once on the verified success page or upon rotation, stored only as SHA-256 hashes, rate-limited, rotatable from settings, and used for cross-device recovery. Security rate limits use a day-scoped HMAC bucket rather than storing a raw client IP in the application database; production should configure `DABLAJA_RATE_LIMIT_SECRET`. Refunds/disputes revoke the license.

To verify VPS signing key alignment safely without exposing secrets:
```bash
python3 scripts/verify-signing-key.py --env-file /etc/dablaja.env
```

## Security model and important BYOK trade-off

- The key is stored only in `chrome.storage.local`, never sync storage, and is revealed only when the user explicitly presses the show/change control.
- Audio is never stored. Captions exist in extension-page memory; while local saving is enabled, a bounded transcript draft (plus temporary title/page URL) may additionally live in `chrome.storage.session` so service-worker suspension does not lose the session before finalization or an explicit save.
- Saved transcripts, titles, and URLs remain local on this device.
- No ads, content scripts, or browsing-history collection.
- Core audio and transcripts go directly to Google; they never pass through the developer server.
- With separate opt-in consent, the extension sends only dubbed duration, a coarse platform category (`youtube`, `x`, `twitch`, `other`), and allowlisted technical error diagnostics (`event_id`, bounded `error_code`, `status`, `site_host`, `extension_version`, `reconnect_count`) to `audiofetcher.com`. Diagnostics do not include the stable licensing installation ID. Never arbitrary error messages, stack traces, URLs, titles, audio, transcripts, or keys. Declining does not affect dubbing.
- Feedback and uninstall forms are user-submitted and hosted on `audiofetcher.com`.
  They receive only the submitted reason/message, optional email, source label,
  and a one-time deduplication ID; form records are removed within 180 days and
  no browser user agent or stable installation ID is retained.
- No runtime dependency, remote code, `eval`, or inline script.
- Logs intentionally exclude keys, URLs, audio, and transcripts.

Google recommends ephemeral tokens for client-to-server Live API apps. Ephemeral tokens require a provisioning backend. V1 intentionally has no backend and uses a user-owned key, so the API key must be present on the user's device and is placed in the WebSocket authentication URL by the browser, as Google's raw WebSocket protocol requires. Do not use a high-privilege multi-purpose key; create/restrict a dedicated key where Google Cloud controls allow it, and delete it from the extension when not needed.

## Pricing note

Free users can locally save 1 session, 1 bookmark, and 1 site profile. Local saving is enabled by default and can be disabled. Plus unlocks up to 500 sessions, 100 bookmarks per session, and 50 site profiles for a one-time $10 payment. Availability and rate limits for Google's Live Translate API are controlled by Google; check Google's current [Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing) for details on free-tier and paid-tier data use and text-token charges.

## Development and packaging

```powershell
npm run verify        # tests + server tests + static checks + manifest validation
npm run package:dev      # development/test ZIP; never submit this build
npm run package:release  # release ZIP; refuses until every acceptance gate passes
```

`package:dev` re-runs static and manifest checks, copies only runtime files into a clean staging folder, rejects common secret/test/dev artifacts, and creates an unmistakably named build:

`dist\dablaja-v1.0.0-DEVELOPMENT-PREVIEW.zip`

`package:release` additionally enforces manifest/package version parity, requires the development entitlement switch to remain disabled, and requires explicit Chrome/listening/VPS/Stripe/clean-profile acceptance evidence. It does not publish or upload anything.

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
