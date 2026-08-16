# Test report — dablaja 0.3.0 (Plus corrective passes)

**Date:** 16 August 2026  
**Environment:** Windows 11, Node.js 22, Python 3.11 (server unit test). No Chrome was controlled in this pass.

## Commands actually run

| Command | Result |
|---|---|
| `npm run verify` | PASS — see breakdown below |
| `npm run package:dev` | PASS — creates `dist/dablaja-v0.3.0-DEVELOPMENT-PREVIEW.zip` (52 files, manifest at root) |
| `npm run package:release` | **FAILS AS REQUIRED** — `Release build refused: PLUS_DEV_PREVIEW_ENABLED is still true in src/shared/plus-entitlement.js`; npm exits 1; no ZIP is produced |

## Automated verification detail (2026-08-16, after the data-integrity pass)

| Check | Result |
|---|---|
| Node tests | PASS — **170 tests**: all prior suites (controller lifecycle/races, message-boundary gating, integration, entitlement verifier, integrity/durability/backup) plus the final corrections: in-flight note edits drained without loss, second-commit failure blocking navigation, 10-into-495 import reporting added=5/rejected=5/updated=0, full-library truthful counts, superseded duplicates, non-string backup rejection |
| Server test | PASS — `server/test_dablaja.py`, 1 test |
| Syntax/security scan | PASS — 29 runtime JavaScript files; no secrets, console output, dynamic code, inline script, or inline style blocks |
| Manifest validation (dev) | PASS — MV3, five permissions, Gemini + AudioFetcher hosts only, strict CSP, 20 referenced/required runtime files; prints the development-preview warning |
| Manifest validation (release, `DABLAJA_RELEASE=1`) | FAILS by design while the preview flag is on; also enforces manifest/package version parity |

## Corrective-pass coverage (all backed by the new tests)

- Full HTTP(S) origin/URL → `hostname[:port]` normalization shared by sessions and site profiles; real `originOf()` output accepted; credentials/fragments never stored.
- Title fallback (page title → hostname sans `www.` → placeholder) in drafts and the library list.
- Entitlement: a plain local `{ state: "active" }` record can never unlock Plus; only the verifier-pipeline shape (or the labelled dev preview) can; revoked/expired verified records beat the preview switch; malformed input defaults to locked.
- Draft controller: entitled-only capture, serialized generation-checked writes, stale-session rejection, mid-session save → continue → stop produces ONE record, idempotent finish, revocation freeze, saved-vs-unsaved reload recovery, byte-budget truncation with disclosure, IDB-failure fallback to unsaved draft with warning.
- Message boundary: every paid mutation rejected while locked (10 message types tested); read/export/delete of owned data remains available; import parses raw text inside the worker — renderer "parsed" claims ignored; consistent `{ ok, plus, draft, storageWarning }` shape.
- IndexedDB: updates allowed at the 500 cap, new records rejected with the Arabic limit message, batch import planned deterministically (deduped) and written atomically; `onversionchange` closes the cached connection.
- Multiline notes sanitizer: line breaks preserved, per-line trimming, blank-line reduction, safe default length.
- No API key/audio fields in exports/backups (existing suites re-run); anonymous-statistics consent gating unchanged (telemetry suite re-run).

## Manual Chrome testing — PENDING

No real Chrome, Gemini API, or audio testing was performed in this pass. Before release evaluation, run TEST_PLAN items 1–24 in Chrome, especially: explicit key consent, locked-vs-preview entitlement via a test override, live save-halfway→continue→stop→one-record, stopped-draft save with title/URL, autosave, fatal/start-failure cleanup, notes/bookmarks, TXT/SRT/JSON/print, backup/import, site volume profiles (effective slider values), reload during/after a session, and console inspection. Automated tests here do NOT substitute for that listening/UI confirmation.

## Known constraints

- The observed-latency badge, silence gating, and audio-quality constraints from 0.2.0 still apply.
- `landing/styles.css` contains pre-existing unrelated visual work and was intentionally not touched by this pass.
