# Test report — 0.1.0 MVP

**Date:** 2026-08-11  
**Environment:** Windows workspace; Node 22.18.0; Chrome integration pending user-only load/key actions.

## Automated results

**PASS — latest run after lifecycle/audio fixes:**

| Check | Result |
|---|---|
| Node test runner | 15/15 tests passed; 0 failed/skipped/cancelled |
| Audio/data utilities | PCM16, mono conversion, resampling, base64, RMS, bounded queue passed |
| Protocol | Setup/audio schema, camel/snake parsing, and failure classification passed |
| Lifecycle/cleanup | Normal/reconnect transitions, impossible transition rejection, LIFO/idempotent cleanup passed |
| Runtime syntax/security scan | 10 JavaScript files passed; no key-pattern, console, dynamic-code, inline-script, or inline-style findings |
| Manifest validation | MV3, exact five permissions, one host, CSP, and 7 referenced runtime paths passed |
| Clean package | `dist/arabic-live-dubbing-v0.1.0.zip` created with 22 files and root `manifest.json` |

Commands completed with exit code 0:

```text
npm run verify
npm run package
```

## Chrome/manual results

| Test | Status | Evidence / blocker |
|---|---|---|
| Load unpacked | PASS | User loaded the workspace extension and reached its runtime status UI. |
| Popup/RTL visual | PENDING | Inspect after unpacked load. |
| Key save/change/delete | PENDING | User must enter their own key through the popup only. |
| Consent gate | PENDING | Verify in popup. |
| Invalid-key handling | PENDING | Use a deliberately invalid placeholder, never the user's valid key in logs/chat. |
| Valid Gemini start | RETEST | First attempt exposed a teardown race; after fixing it, safe diagnostics reported `WSS 1007`. Root protocol mismatch identified: Google's official SDK emits transcription configs at setup level, while the Live Translate raw example nests them. Payload corrected to the SDK/observed-server shape; reload/retry pending. |
| Bilingual captions | PENDING | Requires live API output. |
| Pause/resume | PENDING | Requires live tab. |
| Both volume controls | PENDING | UI and human hearing verification required. |
| Stop/restart ×3 | PENDING | Chrome runtime required. |
| Navigation/tab closure | PENDING | Chrome runtime required. |
| Extension reload | PENDING | Chrome runtime required. |
| Second non-YouTube source | PENDING | Chrome runtime required. |
| Console/error/leak inspection | PENDING | Chrome runtime required. |
| 15–20 minute sustained run | PENDING | Valid key plus user time required. |
| Human listening confirmation | PENDING | Cannot be judged by automation. |

## Acceptance status

**Not yet accepted.** Implementation completion and automated success do not prove that a preview Gemini model is enabled for the user's key/region or that real audio sounds acceptable. Core V1 will be marked complete only after the pending Chrome/API/listening checks have direct evidence.
