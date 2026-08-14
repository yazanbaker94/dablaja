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
11. Manifest V3, exact minimal permission set, host scope, CSP, and referenced file validation.
12. Clean package generation and ZIP-root manifest check.

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
| 4 | Consent gate | Save rejected without checkbox; disclosure visible before transmission. |
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

## Human listening prompt

After a valid session has produced Arabic output, ask the tester to confirm exactly:

1. Arabic voice is audible.
2. Original voice is quieter and both sliders have an audible effect.
3. Delay is acceptable for the test content.
4. There is no severe crackling, overlapping runaway audio, or steadily increasing lag.

Browser automation must not mark these as passed without that confirmation.
