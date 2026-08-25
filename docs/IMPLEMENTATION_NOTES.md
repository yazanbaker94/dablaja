# Implementation notes and official sources

Research date: **2026-08-11**; implementation status reviewed **2026-08-25**. Only official Google/Chrome documentation was used to select the API and extension architecture.

## Gemini Live Translate

- [Live translation with Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/live-translate) — authoritative model, raw WebSocket setup/message shapes, 16 kHz PCM input, 24 kHz PCM output, 100 ms chunks, transcription settings, Arabic `ar`, and supported-language list. Page last updated 2026-07-23 when researched.
- [Live API session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) — ~10-minute connection lifetime, 15-minute uncompressed audio-only sessions, context compression, session resumption tokens, and `GoAway` handling.
- [Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices) — 20–100 ms chunks, 16 kHz resampling, compression/resumption guidance, and cost cautions.
- [Live API WebSocket quickstart](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) — v1beta raw WebSocket authentication and protocol.
- [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) — client-to-server recommendation. V1 cannot use these without violating the explicit no-backend architecture, so it uses local BYOK and documents that trade-off prominently.
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) — current Live Translate pricing and free/paid data-use disclosure. Pricing is linked, not hard-coded into the UI.

### Protocol choices

`generationConfig` contains response modalities and `translationConfig`. The current official `@google/genai` source serializer places `inputAudioTranscription` and `outputAudioTranscription` directly under `setup`, along with setup-level `contextWindowCompression` and `sessionResumption`. Although the Live Translate page's raw JSON example currently nests transcription objects in `generationConfig`, live testing rejected that shape with WebSocket code 1007. The implementation therefore follows the official SDK serializer and observed server behavior. The parser accepts both protobuf JSON camelCase and defensive snake_case variants.

- [Official `@google/genai` live converter source](https://github.com/googleapis/js-genai/blob/main/src/converters/_live_converters.ts) — authoritative client config → Developer API wire mapping used to resolve the documentation/example mismatch.

## Chrome extension platform

- [`chrome.tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) — explicit user invocation, stream ID constraints, audio suppression behavior, routing captured audio back to `AudioContext.destination`, and service-worker-to-offscreen use since Chrome 116.
- [`chrome.offscreen`](https://developer.chrome.com/docs/extensions/reference/api/offscreen) — one static hidden document, runtime-only extension API access, reasons, and lifecycle.
- [`chrome.sidePanel`](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) — MV3 permission/default path and opening from an extension-page user gesture.
- [Cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) — narrow host permission and `connect-src` considerations.
- [Chrome Web Store user-data policy](https://developer.chrome.com/docs/webstore/user_data) and [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) — prominent disclosure/consent, minimum permissions, allowed transfer, advertising prohibition, and required statement.

### Permission decision

No `tabs`, scripting, content-script, history, webRequest, microphone, or broad host permission is used. `activeTab` plus `tabCapture` scopes capture to the user-invoked active tab. `storage`, `offscreen`, `sidePanel`, and `alarms` support local settings/library state, audio processing, persistent captions, and license refresh. Host access is limited to `https://generativelanguage.googleapis.com/*` for Gemini and `https://audiofetcher.com/*` for optional aggregate diagnostics, user-submitted forms, and Plus checkout/licensing. Audio and transcripts never pass through AudioFetcher. CSP permits only those required HTTPS/WSS destinations.

## Audio behavior

- The captured stream is connected through an `originalGain` node to the destination because tab capture suppresses normal local playback.
- A capture worklet downmixes arbitrary channel counts, streaming-resamples the device rate to 16 kHz, encodes PCM16, and emits exact 1,600-sample chunks.
- Sustained near-silence is not transmitted indefinitely; 300 ms pre-roll protects speech onset after a pause.
- A playback worklet decodes PCM16, streaming-resamples 24 kHz to the actual device context rate, adaptively prebuffers 280–520 ms, and bounds queued output to 2.5 seconds. Short jitter gaps stay in the playhead as silence; only an 80 ms dry run counts as a hard underrun and grows the prebuffer. If backlog exceeds the cap it drops stale content to approximately 1.2 seconds. Incoming odd PCM bytes are carried to the next chunk. Fade-in is used after a real gap only. A compressor/limiter protects peaks; optional ducking lowers the original path only while translated playback is active.
- Live Translate is a continuous interpreter, not a turn-taking agent. The client does not flush already-received Arabic audio on `interrupted`. After two seconds of source silence it sends `audioStreamEnd` so Gemini can flush cached input cleanly. `GoAway` audio in the same message is played first; reconnect waits for `timeLeft` when the server still has time.
- The latency display is observed activity-to-first-returned-audio and is explicitly approximate.

## Stripe Checkout and Plus licensing

- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment) — fulfillment is server-side and idempotent; immediate and delayed payments are handled through `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`.
- [Stripe event types](https://docs.stripe.com/api/events/types) — `checkout.session.expired` cleans abandoned attempts; `refund.created` and `charge.dispute.created` revoke the corresponding lifetime license according to the disclosed refund/dispute policy.
- [Stripe webhook security](https://docs.stripe.com/webhooks?lang=python) — the server verifies the untouched raw body and `Stripe-Signature` with the official Python SDK before any mutation.
- [Stripe refund guidance](https://docs.stripe.com/refunds) — Stripe recommends listening for `refund.created`; the server treats any full or partial refund as revocation, matching the Terms.

The server pins `stripe==15.5.0`. Checkout retrieval explicitly uses API version `2025-03-31.basil`, the account's known Managed Payments-compatible contract, instead of silently changing object semantics whenever the SDK default advances. Payment card numbers are handled by Stripe Checkout and never reach Dablaja.
