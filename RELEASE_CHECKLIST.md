# Release checklist

## Dablaja Plus gate (blocking)

- [ ] Stripe payment/license integration implemented per `src/shared/plus-entitlement.js` contract.
- [ ] `PLUS_DEV_PREVIEW_ENABLED` set to `false` in `src/shared/plus-entitlement.js` and no UI shows «نسخة تطوير Plus».
- [ ] `npm run package:release` succeeds (it refuses while the development-preview entitlement remains enabled) and enforces manifest/package version parity.
- [ ] `npm run package:dev` output is used only for local testing; its `-DEVELOPMENT-PREVIEW` ZIP must never be uploaded.
- [ ] Store copy still does not advertise Plus as purchasable unless Stripe is live.
- [ ] Plus privacy disclosures (local-only storage, no audio, no AudioFetcher content) verified in `PRIVACY.md`, `privacy.html`, and `landing/privacy.html`.

## Code and quality

- [ ] `npm run verify` passes from a clean checkout.
- [ ] `npm run package` creates the expected clean ZIP.
- [ ] Unpack and inspect ZIP: no tests, source maps, logs, caches, `.env`, secrets, or dev scripts.
- [ ] Search repository and ZIP for API keys and personal/sensitive test transcripts.
- [ ] All Chrome/manual cases in `TEST_REPORT.md` have evidence or a clearly accepted residual risk.
- [ ] Human listening confirmation recorded.
- [ ] Sustained 15–20 minute session completed without runaway buffer or repeated exceptions.

## API/product accuracy

- [ ] Re-check the official Live Translate guide for model ID, endpoint, sample rates, chunks, and schema on release day.
- [ ] Re-check model region/age restrictions, quotas, rate limits, pricing, free-tier data use, and preview status.
- [ ] Confirm session resumption/context compression remain supported by Live Translate.
- [ ] Update store copy if free-tier or paid-tier data handling changed.
- [ ] Do not describe any tier as unlimited.

## Privacy/security

- [ ] Review minimal permissions and host scope again.
- [ ] Confirm consent is shown before first audio transmission.
- [ ] Confirm key never enters sync storage or UI state responses.
- [ ] Confirm stop closes tracks, socket, contexts/worklets, timers, queues, and restores normal tab audio.
- [ ] Inspect worker/offscreen/side-panel consoles for sensitive values and repeated errors.
- [ ] Replace temporary publisher/support wording with real publisher identity and support email.
- [x] Host `privacy.html` on a stable HTTPS URL controlled by the publisher: `https://audiofetcher.com/dablaja/privacy.html`.
- [x] Publish Dablaja terms at `https://audiofetcher.com/dablaja/terms.html`.
- [ ] Complete Web Store data-use questionnaire exactly as documented in `STORE_LISTING.md`.
- [ ] Add the Limited Use disclosure one click away from the product homepage/store support surface.

## Store assets and submission (later; not part of this task)

- [ ] Confirm final name and branding clearance.
- [ ] Capture clean screenshots with no API key, sensitive tab content, or personal captions.
- [ ] Prepare required promotional images without copying competitor assets.
- [ ] Verify icon legibility at 16, 32, 48, and 128 px.
- [ ] Add support URL/email and category/language metadata.
- [ ] Test the exact ZIP on a separate clean Chrome profile.
- [ ] Create a version tag and archive checksums/test report.
- [ ] Submit only after explicit owner approval; do not auto-publish.
