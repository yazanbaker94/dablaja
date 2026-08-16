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
11. Consent-gated community telemetry and exact three-field usage payload.
12. Server deduplication/aggregation with no URL, title, audio, transcript, key, or install-ID columns.
13. Manifest V3, exact minimal permission set, host scope, CSP, and referenced file validation.
14. Clean package generation and ZIP-root manifest check.
15. Plus entitlement states: development preview, locked, active, expired/revoked; malformed licenses ignored.
16. Plus draft lifecycle: interim/cumulative merge, punctuation and final-flag finalization, source/target separation, reconnect duplicate suppression, snapshot-vs-live independence, stop finalization.
17. Plus bounds: segment text, per-channel segment counts, bookmarks, notes/title sanitization, session and draft caps, total-character ceiling.
18. Plus search normalization: Arabic diacritics/tatweel/letter-form folding, case folding, AND semantics, title/notes/bookmark/transcript matching.
19. Plus exports: TXT/SRT/JSON content and timestamps, bilingual SRT pairing, zero-length cue handling, forbidden-field absence.
20. Plus backup: envelope validation, malformed rejection, per-record validation, merge dedupe by newest, session cap, import never deletes existing data.
21. Per-site volume profiles: origin normalization, partial updates, clamping, exact-origin lookup, insertion-order eviction, deletion.
22. Explicit Gemini key-save consent (unchecked checkbox blocks save; masked viewing does not re-require it).

Commands:

```powershell
npm run verify
npm run package
```

## Chrome integration matrix

Use Chrome 116 or later with the unpacked workspace root.

| # | Scenario | Evidence required |
|---:|---|---|
| 1 | Unpacked installation | No manifest errors; icon, popup, and side panel registered. |
| 2 | Popup RTL layout | Visual screenshot/inspection; no clipped controls. |
| 3 | Key save/change/delete | Masked field; local-only behavior; key never appears in UI response or console. |
| 4 | Consent gates | Google audio disclosure precedes key use. Separate anonymous-statistics disclosure supports accept, decline, and later withdrawal; declining must not block dubbing. |
| 5 | Invalid key | Actionable Arabic error; capture/audio restored; no reconnect loop. |
| 6 | Valid start | Ready → connecting → listening/translating. |
| 7 | Captions | Source and Arabic text update in side panel; no storage entries contain text. |
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
| 19 | Plus save flow | Side-panel «احفظ الجلسة» during a live session stores bilingual transcript in the library (IndexedDB); URL captured only at save. |
| 20 | Plus library UI | Search filters cards; detail shows bilingual timeline; notes save; bookmarks add/edit/delete; exports (TXT/SRT/JSON/print) download; delete + delete-all with confirmation. |
| 21 | Plus backup | Full backup export downloads; importing a tampered or wrong-kind file is rejected with an Arabic error; valid import merges without losing existing sessions. |
| 22 | Plus drafts | Stop without saving keeps the draft card (≤3); starting a new session preserves the previous draft; discarding removes it. |
| 23 | Plus entitlement | Dev-preview chip «نسخة تطوير Plus» visible in library; features gated when entitlement disabled. |
| 24 | Site volume profiles | Opt-in toggle; volumes applied on next session start for the same hostname; profile deletable; off by default. |

## Human listening prompt

After a valid session has produced Arabic output, ask the tester to confirm exactly:

1. Arabic voice is audible.
2. Original voice is quieter and both sliders have an audible effect.
3. Delay is acceptable for the test content.
4. There is no severe crackling, overlapping runaway audio, or steadily increasing lag.

Browser automation must not mark these as passed without that confirmation.

## Plus corrective-pass additions (0.3.0)

23. Draft controller lifecycle: entitled-only capture, serialized writes, stale-generation rejection, mid-session save updating one record at stop, idempotent finish, revocation freeze, reload recovery (saved vs unsaved), byte-budget truncation, IDB-failure fallback.
24. Message-boundary entitlement enforcement: all paid mutations rejected while locked; read/export/delete of owned data remains available; raw-backup parsing happens only in the service worker.
25. IndexedDB cap: updates allowed at 500, new records rejected with an actionable Arabic error, deterministic deduped batch planning, atomic import.
26. Multiline note sanitizer, origin normalization, and title fallback ordering.
27. Packaging gates: `package:dev` preview ZIP naming; `package:release` refusal while the preview flag is on and manifest/package version parity.
