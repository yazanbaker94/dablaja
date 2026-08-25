# Release acceptance — dablaja 1.0.0

**Date:** 25 August 2026  
**Decision:** PENDING

This file is a hard release gate. Change the decision to `APPROVED` only after
every evidence marker below is backed by a real test performed against the
exact release candidate. Creating this file or passing unit tests is not release
approval.

## Required evidence markers

- Human listening: PENDING
- Sustained session: PENDING
- VPS signing key: PASS
- Stripe webhook: PASS
- Store extension origin: PENDING
- Clean-profile ZIP: PENDING

## Current automated evidence

- `npm run verify`: PASS on 25 August 2026 (299 Node tests and 115 Python tests
  on the current reviewed worktree; rerun against the final candidate before
  approval).
- Static syntax/security checks, ESLint, element bindings, and manifest
  validation: PASS in the same run.
- Development package: may be produced for local testing only.
- Production package: intentionally blocked while this decision and any marker
  remain pending.

The reviewed backend, privacy policy, and terms were deployed on 25 August
2026 and matched their live files by exact SHA-256. The service was active,
the dedicated rate-limit secret was configured without printing it, the Stripe
SDK version was 15.5.0, and the read-only database audit passed. These checks do
not replace the still-pending real refund/dispute lifecycle test.
The live Dablaja Stripe account (`acct_1U6X6LIVWhSNOyU5`) was also verified to
contain the active $10 USD lifetime product and price used by the server. Its
production webhook is enabled at `https://audiofetcher.com/dablaja/webhook`
for the six implemented events. The signing secret was stored directly on the
VPS without being displayed; a correctly signed synthetic event returned 200,
an invalid signature returned 400, and Stripe Dashboard showed the endpoint as
active with six events. A real refund/dispute lifecycle test remains pending.

The on-host signing-key check derived and compared only SHA-256 public-key
fingerprints. Both matched (`sha256:4de76361c8f9b09f`) on 25 August 2026; no
private key material was printed or copied from the VPS.

## Still required before approval

1. Reload the unpacked extension from the final workspace and test the Gemini
   disclosure/key flow, invalid key, start, captions, both volume controls,
   pause/resume, stop/restart, navigation, tab closure, and extension reload.
2. Obtain human confirmation that Arabic audio is audible, original audio is
   quieter, delay is acceptable, and there is no severe crackling or overlap.
3. Run a 15–20 minute live session and inspect worker/offscreen/side-panel
   consoles plus buffer/CPU/memory evidence.
4. Verify a real refund/dispute revokes the bound license without printing
   secrets.
5. Replace development-origin access with the fixed Web Store extension origin.
6. Build and load the exact release ZIP in a separate clean Chrome profile.
