# Release checklist — dablaja 1.0.0

Checked items require current evidence in `TEST_REPORT.md` or
`RELEASE_ACCEPTANCE.md`. Pending manual work stays unchecked; accepted risk is
not equivalent to a passed release requirement.

## Automated code and package checks

- [x] Manifest V3 permissions and host permissions are allowlisted.
- [x] Extension CSP forbids remote executable code and `unsafe-eval`.
- [x] API key uses `chrome.storage.local`, never sync storage.
- [x] Gemini key save requires the visible in-product processing disclosure.
- [x] Anonymous usage/error reporting is off until separately enabled.
- [x] Feedback and uninstall URLs omit the persistent installation identifier.
- [x] Free and Plus storage limits are enforced and existing local records are not held hostage.
- [x] Licensing tokens are Ed25519-signed and installation-bound.
- [x] Privileged licensing requests require a high-entropy installation credential.
- [x] Authenticated refund/dispute revocation reaches the client as `status: revoked`.
- [x] Legacy credential bootstrap rejects tokens beyond the seven-day expiry horizon.
- [x] Recovery-code plaintext is shown once and stored server-side only as a hash.
- [x] Package construction uses an explicit runtime allowlist and validates imported dependencies/resources.
- [x] `npm run verify` passes on the current worktree.
- [x] `git diff --check` reports no content errors.

## Chrome runtime acceptance

- [ ] Reload the unpacked extension from the exact workspace.
- [ ] Popup RTL layout, disclosure, key save/change/delete, and masking verified.
- [ ] Invalid/revoked key produces an actionable error without leaking the key.
- [ ] Start reaches connecting/listening/translating on an ordinary audible tab.
- [ ] Source and Arabic captions update in the side panel.
- [ ] Original and dubbed volume controls both work and persist correctly.
- [ ] Pause/resume does not send silence forever or corrupt the session.
- [ ] Stop/restart repeated at least three times with full cleanup.
- [ ] Tab navigation and tab closure clean up the session.
- [ ] Extension reload recovers or preserves drafts without silent permanent saving.
- [ ] Plus save, notes, bookmarks, search, exports, backup/import, and profile limits verified.
- [ ] Checkout, activation polling, recovery, and recovery-code rotation verified in Chrome.
- [ ] Worker, offscreen, side-panel, popup, library, stats, and diagnostics consoles inspected.
- [ ] Human listening confirms Arabic audio, lower original audio, acceptable delay, and no severe crackling/overlap.
- [ ] Sustained 15–20 minute session shows no runaway buffer, reconnect loop, or obvious resource leak.

## VPS, Stripe, and deployment acceptance

- [x] Deployed server and live privacy/terms hashes match the reviewed local files.
- [x] `DABLAJA_LICENSE_SIGNING_KEY` matches `PLUS_LICENSE_PUBLIC_KEY_B64` by safe fingerprint.
- [x] A high-entropy `DABLAJA_RATE_LIMIT_SECRET` is configured on the VPS without exposing its value.
- [x] `STRIPE_WEBHOOK_SECRET` is configured and a signed test webhook succeeds.
- [ ] Refund and dispute events revoke the local license on the next authenticated refresh.
- [ ] Production CORS contains only the fixed Web Store extension origin; development origins are disabled.
- [x] Admin authentication uses the HttpOnly/Secure/SameSite cookie flow and no token appears in URLs or markup.
- [x] Live privacy policy and terms match the reviewed local documents by SHA-256.

## Store submission

- [ ] Official Gemini model/protocol/pricing/quota/preview status rechecked on submission day.
- [ ] Store data-use questionnaire copied exactly from `STORE_LISTING.md`.
- [ ] Final screenshots contain no key, private captions, or sensitive tab content.
- [ ] Icons and promotional assets verified at required dimensions.
- [ ] Exact release ZIP loads in a separate clean Chrome profile.
- [ ] ZIP contains no tests, previews, mocks, maps, secrets, logs, caches, or dev scripts.
- [ ] `RELEASE_ACCEPTANCE.md` contains all six `PASS` markers and `Decision: APPROVED`.
- [ ] Tag/checksum/archive created after explicit owner approval.
- [ ] Publish action remains manual; no automatic submission or deployment.
