# Test report — dablaja 1.0.0

**Current evidence date:** 25 August 2026
**Release decision:** pending manual Chrome/listening, refund/dispute, Store-origin, and clean-profile acceptance.

## Automated evidence

| Check | Current result |
|---|---|
| `npm test` | PASS — 308/308 Node tests on the current worktree |
| `python -m unittest server/test_dablaja.py` | PASS — 115/115 backend tests on the current worktree |
| `node scripts/check.mjs` | PASS — 34 JavaScript files |
| Element-binding checker | PASS — library, popup, stats, side-panel, and diagnostics bindings; duplicate IDs and unwired static controls are rejected |
| ESLint | PASS |
| Manifest and Store-asset validation (development) | PASS — manifest plus exact 16/32/48/128 icons, 128px Store-icon safe-area padding, 440x280 small promo, and 1400x560 marquee; emits an intentional warning because a real-operation screenshot is still pending |
| `npm run smoke` | PASS — isolated unpacked Edge/Chromium profile; popup, static Gemini disclosure/key flow, analytics default-off/opt-in, local-saving default-on, volumes/site profile, library, stats, side panel, diagnostics, and console checks |
| `npm run e2e` | PASS — 51/51 default checks; live-server mode 54/54; live-Checkout mode 52/52 and opened an independently validated production `checkout.stripe.com` URL without entering payment details or purchasing |
| Release validation | PASS as a guard: it refuses because acceptance evidence is pending |
| `git diff --check` | PASS; line-ending notices only |
| Official Gemini documentation recheck | PASS on 25 August 2026 — model `gemini-3.5-live-translate-preview`, 16kHz PCM input, 24kHz PCM output, 100ms chunks, Arabic `ar`, input/output transcription, and current pricing/data-use copy match Google documentation |
| VPS signing-key fingerprint | PASS — derived and expected public fingerprints both `sha256:4de76361c8f9b09f`; no private key output |
| VPS deployment hashes | PASS — reviewed server (`94c72207…6c445`), landing HTML (`37d94e78…35483`), landing CSS (`ec85b982…ee8bf`), updated privacy (`a4dbedcf…ab11e`), and terms (`d4b1a83e…26ce2`) files match their live SHA-256 hashes |
| VPS database audit | PASS — exact allowlisted diagnostic/form schemas (obsolete empty `error_message`/`user_agent` columns removed), hashed credentials, unique event/submission IDs, allowlisted/nonnegative aggregate usage, and enforced 8/30/45/180-day retention windows |
| VPS response headers | PASS — feedback, uninstall, admin, success, licensing, usage, diagnostics, checkout, and webhook routes are `no-store`/`no-referrer`; form/success pages have route-scoped no-script CSP; public aggregate stats retain their intended 60-second cache policy |
| VPS runtime | PASS — service and Caddy active, health/statistics/privacy probes successful, Stripe SDK 15.5.0, and a dedicated rate-limit secret is configured |
| Live landing browser QA | PASS — desktop and mobile rendered without material horizontal overflow; mobile navigation and install anchors work; the embedded Gemini tutorial loads from `youtube-nocookie.com`, locks root/body scrolling, closes to `about:blank`, and reopens; the full demo pauses and resets to 0 on close-button and outside-click paths, then replays; no landing console warnings/errors |
| Live Caddy tutorial policy | PASS — full-root candidate preserved shared imports, validated with the service environment, reloaded successfully, and now permits only Cloudflare plus the two required YouTube frame origins; live root SHA-256 `8c4dc520…c6637` |
| Live E2E cleanup | PASS — current production-ingestion run created one reserved usage row and one reserved diagnostic row; apply mode created and integrity-checked an online SQLite backup before transactional removal; post-cleanup dry-run found zero synthetic rows and public stats returned 60 sessions |
| Stripe product/price | PASS — live Dablaja account, active lifetime product, active $10 USD price, and exact server IDs all match |
| Stripe webhook | PASS — production endpoint active for six required events; secret stored on VPS without output; signed probe 200; invalid signature 400 |
| Development ZIP inspection | PASS — 57 allowlisted files, manifest at root, checkout validator present, and no test/preview/mock/map/secret/dev path or secret pattern |

## Corrections verified by production-code tests

- Concurrent installation-identity callers share one read/write window and one
  generated identifier/credential pair; failure is retryable.
- Paid endpoints authenticate the installation credential and store only its
  SHA-256 hash on the server.
- Retention pruning parses ISO timestamps correctly, removes unpaid/failed
  Checkout attempts after 30 days, and preserves completed purchase records.
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
- Start is single-flight, Stop waits for an in-flight startup before disposing
  resources, and a duplicate Start cannot tear down a healthy active session.
  A delayed Chrome capture-stop event also rechecks the current tab capture
  before it may stop a replacement session on the same tab.
- Offscreen reconnect/setup timers plus socket, worklet, and track callbacks are
  bound to the session that created them; stale events cannot mutate a
  replacement session or clear its network watchdog.
- Recovery rotation uses the extracted production controller, prevents duplicate
  requests, keeps plaintext visible only in the modal, wipes it on close/unload,
  and reports ambiguous network results honestly.
- Gemini key entry includes a visible, non-blocking in-product disclosure.
  Saving the key alone sends no audio; capture and Google processing begin only
  after the user explicitly presses Start.
- Gemini session resumption is intentionally absent from both accepted setup
  shapes. A reconnect starts a fresh translation session because Google now
  documents that generated resumption handles may retain live conversation
  state, including audio and text, for up to 24 hours. Context-window
  compression remains enabled.
- Anonymous aggregate usage/error reporting is exact opt-in. Usage sends only a
  one-time event ID, coarse platform category, and bounded duration. Error
  diagnostics use an allowlisted schema and never free-form messages, keys,
  URLs, titles, audio, or transcripts.
- Feedback and uninstall links include only their source, not a stable install
  ID. The form uses a one-time submission ID for duplicate prevention and the
  production database has no user-agent column. Live records satisfy the stated
  180-day retention boundary; diagnostic and usage-deduplication records satisfy
  their respective 45-day and eight-day boundaries.
- Free storage is one saved session, one bookmark, and one site profile; Plus is
  bounded at 500 sessions, 100 bookmarks per session, and 50 profiles. Existing
  locally owned records stay readable.
- Runtime package dependencies and local HTML/CSS resources are checked against
  the explicit ZIP allowlist.
- Chrome Web Store assets now have a separate validated submission directory.
  The generated brand art is limited to the 440x280 small promo and optional
  1400x560 marquee; the eight historical AI mockups are explicitly excluded as
  screenshots. Release validation requires at least one real 1280x800 (or
  640x400) current-product screenshot and refuses to treat promo art as proof of
  the extension experience.
- Checkout navigation accepts only credential-free HTTPS URLs on
  `checkout.stripe.com`; both the server response and extension navigation are
  independently validated. Failure to open the Stripe tab is reported in
  Arabic and does not start license polling.
- Saved sessions use one honest bundled fallback illustration. The previous
  title-matched decorative thumbnails were removed from runtime and packaging
  so the library never implies that guessed artwork came from the source page.
- The stats page uses one tier-aware Plus action. An entitled user opens the
  library without also invoking Checkout; navigation failures on stats,
  library, popup, and side-panel surfaces are surfaced instead of becoming
  unhandled or silent promise failures.
- Starting dubbing dispatches the worker start command before requesting the
  persistent captions side panel, so Chrome cannot close the popup before the
  start request is sent. If panel opening fails, the popup surfaces an
  actionable fallback. Side-panel start errors and worker storage/licensing
  events are rendered instead of being silently dropped.
- The library now has one compact tier indicator and one upgrade explanation;
  the contradictory duplicate Plus sidebar card was removed. Popup and library
  dialogs expose labelled descriptions, restore focus, close by backdrop or
  Escape when safe, and keep keyboard focus inside the active dialog.
- The isolated browser smoke loads the real service worker and extension pages,
  verifies the static Gemini disclosure, persists a fake test key locally,
  keeps analytics off until explicitly enabled, persists local/profile settings,
  and reports no page or console errors on the tested surfaces.
- Repeated legacy-license backend tests now use scoped temporary directories;
  two consecutive runs left the Dablaja SQLite artifact count unchanged. The
  browser smoke, UI preview smoke, and E2E harness also remove their staged
  extensions, download folders, screenshots, and Chrome profiles after each
  run, preventing release verification from filling the host temp drive.
- The larger isolated E2E run passed 51 default checks. A separate controlled
  run with live AudioFetcher enabled passed 54/54, including invalid recovery
  rejection and exact usage/diagnostic duplicate suppression. The two synthetic
  usage events and one synthetic diagnostic created across the corrective runs
  were removed by reserved ID after an exact database backup; the verifier then
  confirmed zero synthetic E2E rows and restored aggregate counts of 18
  diagnostics, 2 feedback forms, 1 uninstall form, and 60 usage sessions.
  A separate live-Checkout run passed 52/52 after hardening the harness against
  an Edge target-close false-success path. Its reserved Checkout session had no
  purchase, was expired through Stripe, and its reserved database attempt was
  removed after an exact backup. This verifies Checkout creation/navigation,
  not payment completion, activation, refund, or dispute behavior.
- The reviewed backend and landing copy were deployed after an online SQLite
  backup and a successful migration rehearsal against a copy of the live
  database. Both active API replicas (`ytmp3-api@8080` and `@8081`) were
  restarted one at a time. An accidentally started disabled legacy unit was
  stopped; both intended replicas are active with zero restarts and no warning
  log entries. The post-deploy live-ingestion run again passed 54/54 and the
  live-Checkout run 52/52; their reserved rows/session were backup-cleaned and
  the read-only verifier returned every check PASS with original aggregate
  counts restored.

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
- No verified real-operation 1280x800 Store screenshot has been captured from
  the exact current build yet. The required promotional dimensions are ready,
  but the Store screenshot gate remains intentionally open.

Because these are required acceptance criteria, `npm run package:release` must
continue to refuse until `RELEASE_ACCEPTANCE.md` and `RELEASE_CHECKLIST.md` are
truthfully completed.
