# Test plan

## Automated/static

1. PCM16 encode/decode endpoints and round-trip tolerance.
2. Multi-channel to mono conversion and short-channel boundary.
3. Linear resampling output length/boundaries.
4. Base64 PCM byte preservation and message MIME format.
5. CamelCase/snake_case Gemini message parsing.
6. Bounded queue eviction and silence RMS classification.
7. Session lifecycle allowed/forbidden transitions.
8. Cleanup LIFO order, error tolerance, and idempotence.
9. Syntax checks for every runtime JavaScript file.
10. Secret-pattern, logging, dynamic-code, and inline-script/style scan.
11. Explicitly opted-in community telemetry and exact three-field usage payload.
12. Server deduplication/aggregation with no URL, title, audio, transcript, key, or install-ID columns.
13. Manifest V3, exact minimal permission set, host scope, CSP, and referenced file validation.
14. Clean package generation and ZIP-root manifest check.
15. Server retention pruning, including ISO timestamps and 30-day deletion of
    unpaid/failed Checkout attempts while completed purchase records remain.
16. Plus entitlement states: locked, active, offline grace, expired, and revoked; malformed or mismatched licenses ignored.
17. Plus draft lifecycle: interim/cumulative merge, punctuation and final-flag finalization, source/target separation, reconnect duplicate suppression, snapshot-vs-live independence, stop finalization.
18. Plus bounds: segment text, per-channel segment counts, bookmarks, notes/title sanitization, session and draft caps, total-character ceiling.
19. Plus search normalization: Arabic diacritics/tatweel/letter-form folding, case folding, AND semantics, title/notes/bookmark/transcript matching.
20. Plus exports: TXT/SRT/JSON content and timestamps, bilingual SRT pairing, zero-length cue handling, forbidden-field absence.
21. Plus backup: envelope validation, malformed rejection, per-record validation, merge dedupe by newest, session cap, import never deletes existing data.
22. Per-site volume profiles: origin normalization, partial updates, clamping, exact-origin lookup, insertion-order eviction, deletion.
23. Gemini disclosure/key flow (static disclosure remains visible; saving the key alone sends no audio; no obsolete consent checkbox or timestamp remains).

Commands:

```powershell
npm run verify
npm run smoke
npm run e2e
npm run package
```

`npm run e2e` is non-destructive by default. Live AudioFetcher ingestion and
live Stripe Checkout probes remain skipped unless their explicit environment
flags are set for a controlled acceptance run.

The live-ingestion mode uses reserved `e2e…` event IDs. After the assertions,
take a VPS database backup, run `scripts/cleanup-dablaja-e2e.py` first without
`--apply`, then with `--apply`, and rerun `scripts/verify-dablaja-db.py`. This
keeps public community statistics free of synthetic acceptance traffic.

The live-Checkout mode writes a reserved `e2e-checkout-…` installation ID and
opens Checkout without payment. After the assertion, take a VPS database
backup and run `scripts/cleanup-dablaja-checkout-e2e.py` dry-run then `--apply`;
the script refuses completed purchases, expires only an open synthetic Stripe
session, and removes only its reserved attempt row.

## Chrome integration matrix

Use Chrome 116 or later with the unpacked workspace root.

| # | Scenario | Evidence required |
|---:|---|---|
| 1 | Unpacked installation | No manifest errors; icon, popup, and side panel registered. |
| 2 | Popup RTL layout | Visual screenshot/inspection; no clipped controls. |
| 3 | Key save/change/delete | Masked field; local-only behavior; key never appears in UI response or console. |
| 4 | Disclosure and optional sharing | Google audio disclosure is visible beside key entry; audio begins only after Start. The separate anonymous-statistics toggle is off by default, can be enabled/disabled later, and never blocks dubbing. |
| 5 | Invalid key | Actionable Arabic error; capture/audio restored; no reconnect loop. |
| 6 | Valid start | Ready → connecting → listening/translating. |
| 7 | Captions | Start requests the side panel under the same click gesture; source and Arabic text update there; when local saving is disabled, no storage entries contain text. |
| 8 | Audio output | Human confirms Arabic voice, original quieter, controls work, delay acceptable, no severe crackling/overlap. |
| 9 | Pause/resume | Source silence/pause stops indefinite sends; playback resumes after source audio returns. |
| 10 | Stop/restart ×3 | Tracks/socket/context/worklets/timers close; normal tab audio restored; repeatable. |
| 11 | Navigation | Capture continues safely across ordinary same-tab navigation or ends with an actionable state. |
| 12 | Tab closure | Session stops and reports closed tab. |
| 13 | Extension reload | Existing resources terminate; UI reports stopped after reload. |
| 14 | Network loss/recovery | Reconnecting state/backoff; resume handle used when available. |
| 15 | Rate limit/model unavailable | Distinct actionable state; no permanent-error retry loop. |
| 16 | Non-YouTube page | At least one second ordinary audible HTTPS source. |
| 17 | Console inspection | Worker/offscreen/panel show no repeated exceptions and no sensitive output. |
| 18 | Sustained run | Target 15–20 minutes; bounded buffer, reconnection near connection limit, no obvious growth/leak. |
| 19 | Plus save flow | Side-panel «احفظ الجلسة» during a live session stores the bounded bilingual draft in IndexedDB, continues updating the same record, and stop produces exactly one finalized session; while local saving is enabled, source title/origin/URL may already exist only in the temporary local draft. |
| 20 | Plus library UI | Search filters cards; detail shows bilingual timeline; notes save; bookmarks add/edit/delete; exports (TXT/SRT/JSON/print) download; delete + delete-all with confirmation. |
| 21 | Plus backup | Full backup export downloads; importing a tampered or wrong-kind file is rejected with an Arabic error; valid import merges without losing existing sessions. |
| 22 | Draft recovery | Stop automatically finalizes the first free session or an entitled Plus session. Simulated IndexedDB/storage failure keeps one deduplicated recoverable draft (≤3), retry saves it once, and discarding removes it. |
| 23 | Plus entitlement | Free-plan state is locked; a verified license enables Plus; expired/revoked/mismatched licenses lock paid mutations and show actionable status. |
| 24 | Site volume profiles | Opt-in toggle; volumes applied on next session start for the same hostname; profile deletable; off by default. |

## Human listening prompt

After a valid session has produced Arabic output, ask the tester to confirm exactly:

1. Arabic voice is audible.
2. Original voice is quieter and both sliders have an audible effect.
3. Delay is acceptable for the test content.
4. There is no severe crackling, overlapping runaway audio, or steadily increasing lag.

Browser automation must not mark these as passed without that confirmation.

## Corrective-pass additions

23. Draft controller lifecycle: serialized writes, stale-generation rejection, mid-session save updating one record at stop, idempotent finish, revocation freeze, reload recovery (saved vs unsaved), byte-budget truncation, IDB-failure fallback.
24. Message-boundary entitlement enforcement: all paid mutations rejected while locked; read/export/delete of owned data remains available; raw-backup parsing happens only in the service worker.
25. IndexedDB cap: updates allowed at 500, new records rejected with an actionable Arabic error, deterministic deduped batch planning, atomic import.
26. Multiline note sanitizer, origin normalization, and title fallback ordering.
27. Packaging gates: `package:dev` development ZIP naming; `package:release` refusal while the development entitlement switch is on, version parity is broken, any release-acceptance marker is pending, or checklist items remain unchecked.
