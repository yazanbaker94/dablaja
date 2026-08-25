# Test report — dablaja 1.0.0

**Current evidence date:** 25 August 2026
**Release decision:** pending manual Chrome/listening, refund/dispute, Store-origin, and clean-profile acceptance.

## Automated evidence

| Check | Current result |
|---|---|
| `npm test` | PASS — 279/279 Node tests on the current worktree |
| `python -m unittest server/test_dablaja.py` | PASS — 112/112 backend tests on the current worktree |
| `node scripts/check.mjs` | PASS — 34 JavaScript files |
| Element-binding checker | PASS — library, popup, and stats bindings |
| ESLint | PASS |
| Manifest validation (development) | PASS |
| `npm run smoke` | PASS — isolated unpacked Edge/Chromium profile; popup, static Gemini disclosure/key flow, analytics default-off/opt-in, local-saving default-on, volumes/site profile, library, stats, side panel, diagnostics, and console checks |
| `npm run e2e` | PASS — 51/51 safe isolated-browser checks across key lifecycle, settings persistence, free limits, worker-suspension recovery, no-hostage reads, notes/bookmarks/search, export/delete/import gate, locked entitlement, stats, side panel, and local-saving persistence |
| Release validation | PASS as a guard: it refuses because acceptance evidence is pending |
| `git diff --check` | PASS; line-ending notices only |
| VPS signing-key fingerprint | PASS — derived and expected public fingerprints both `sha256:4de76361c8f9b09f`; no private key output |
| VPS deployment hashes | PASS — reviewed server, privacy, and terms files match their live SHA-256 hashes |
| VPS database audit | PASS — expected schema, hashed credentials, no identity/content columns in diagnostics, no install identity or user agent in forms, unique event/submission IDs, allowlisted/nonnegative aggregate usage, and enforced 8/45/180-day retention windows |
| VPS response headers | PASS — feedback, uninstall, admin, success, licensing, usage, diagnostics, checkout, and webhook routes are `no-store`/`no-referrer`; form/success pages have route-scoped no-script CSP; public aggregate stats retain their intended 60-second cache policy |
| VPS runtime | PASS — service and Caddy active, health/statistics/privacy probes successful, Stripe SDK 15.5.0, and a dedicated rate-limit secret is configured |
| Stripe product/price | PASS — live Dablaja account, active lifetime product, active $10 USD price, and exact server IDs all match |
| Stripe webhook | PASS — production endpoint active for six required events; secret stored on VPS without output; signed probe 200; invalid signature 400 |
| Development ZIP inspection | PASS — 57 allowlisted files, manifest at root, checkout validator present, and no test/preview/mock/map/secret/dev path or secret pattern |

## Corrections verified by production-code tests

- Concurrent installation-identity callers share one read/write window and one
  generated identifier/credential pair; failure is retryable.
- Paid endpoints authenticate the installation credential and store only its
  SHA-256 hash on the server.
- Token verification binds license and installation IDs, enforces Ed25519
  signature length, payload bounds, `iat < exp`, future-clock bounds, and the
  seven-day expiry horizon.
- A correctly authenticated revoked installation receives `status: revoked`,
  while a wrong credential receives the same generic unauthorized response as
  an unknown installation. Token renewal and recovery remain unavailable after
  revocation.
- Legacy hash-less installations can bind a credential only with a recent,
  authentic, matching token; an ancient token cannot claim the binding.
- License reconciliation is single-flight, recreates its alarm after worker
  restart, preserves local state during network failure, verifies renewed
  tokens, and locks on authenticated revocation.
- Recovery rotation uses the extracted production controller, prevents duplicate
  requests, keeps plaintext visible only in the modal, wipes it on close/unload,
  and reports ambiguous network results honestly.
- Gemini key entry includes a visible, non-blocking in-product disclosure.
  Saving the key alone sends no audio; capture and Google processing begin only
  after the user explicitly presses Start.
- Anonymous aggregate usage/error reporting is exact opt-in. Usage sends only a
  one-time event ID, coarse platform category, and bounded duration. Error
  diagnostics use an allowlisted schema and never free-form messages, keys,
  URLs, titles, audio, or transcripts.
- Feedback and uninstall links include only their source, not a stable install
  ID. The form uses a one-time submission ID for duplicate prevention and the
  server does not retain its user-agent field. Live records satisfy the stated
  180-day retention boundary; diagnostic and usage-deduplication records satisfy
  their respective 45-day and eight-day boundaries.
- Free storage is one saved session, one bookmark, and one site profile; Plus is
  bounded at 500 sessions, 100 bookmarks per session, and 50 profiles. Existing
  locally owned records stay readable.
- Runtime package dependencies and local HTML/CSS resources are checked against
  the explicit ZIP allowlist.
- Checkout navigation accepts only credential-free HTTPS URLs on
  `checkout.stripe.com`; both the server response and extension navigation are
  independently validated. Failure to open the Stripe tab is reported in
  Arabic and does not start license polling.
- Saved sessions use one honest bundled fallback illustration. The previous
  title-matched decorative thumbnails were removed from runtime and packaging
  so the library never implies that guessed artwork came from the source page.
- The isolated browser smoke loads the real service worker and extension pages,
  verifies the static Gemini disclosure, persists a fake test key locally,
  keeps analytics off until explicitly enabled, persists local/profile settings,
  and reports no page or console errors on the tested surfaces.
- The larger isolated E2E run passed 51 checks. Its live recovery, telemetry
  ingestion, and Stripe Checkout mutations were intentionally disabled; they
  require explicit acceptance flags and are not counted as verified here.

## Evidence not yet obtained

- The exact current extension has not yet been reloaded and retested in the
  user's Chrome after the latest source changes.
- No current human listening confirmation exists.
- No current 15–20 minute live buffer/resource run exists.
- The reviewed backend, privacy policy, and terms were deployed and verified
  against the live files by exact SHA-256 hashes. The service is active and the
  read-only database audit found no legacy raw-IP rate-limit keys, content or
  identity fields in diagnostics, install identity or user-agent retention in
  forms, invalid aggregate usage rows, duplicate IDs, or expired retained rows.
- A real refund/dispute against a bound paid license has not yet been performed;
  unit tests cover both event mappings, but that does not substitute for the
  production lifecycle test.
- Production CORS cannot be finalized until the fixed Web Store extension ID is
  known and configured; the VPS currently has zero fixed extension origins and
  still enables development origins.
- The live admin login returns 401 before authentication, emits
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict no-script
  CSP, no cookie before login, and no `?token=` in markup. Caddy was validated
  and reloaded with the path-scoped headers; its previous file was backed up.
- The exact release ZIP has not been loaded in a separate clean Chrome profile.

Because these are required acceptance criteria, `npm run package:release` must
continue to refuse until `RELEASE_ACCEPTANCE.md` and `RELEASE_CHECKLIST.md` are
truthfully completed.
