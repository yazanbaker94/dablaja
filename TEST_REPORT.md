# Test report — dablaja 0.2.0

**Date:** 15 August 2026  
**Environment:** Windows 11, Chrome, Node.js, Python 3.11, AudioFetcher VPS (`95.217.18.203`)

## Automated verification

| Check | Result |
|---|---|
| Node tests | PASS — 42 tests, including PCM/audio, protocol, lifecycle, captions, queues, local stats, coarse platform classification, minimal payload, and consent gating |
| Server test | PASS — deduplication, aggregation, category percentages, and absence of URL/title/audio/transcript/key/install-ID columns |
| Syntax/security scan | PASS — 16 runtime JavaScript files; no secrets, console output, dynamic code, inline script, or inline style blocks |
| Manifest validation | PASS — MV3, five permissions, Gemini + AudioFetcher hosts only, strict CSP, all runtime files present |
| Clean package | PASS — `dist/dablaja-v0.2.0.zip`, 37 files, root manifest, no tests/source maps/secrets/dev files |

Command: `npm run verify`

## Website and VPS verification

| Scenario | Result / evidence |
|---|---|
| Existing database preserved | PASS — existing `error_reports`, `feedback_reports`, and `daily_budget` remained; migration added only `usage_event_ids` and `usage_daily` |
| Existing feedback data | PASS — 2 feedback and 1 uninstall record observed before migration |
| Safe deployment | PASS — backup `/opt/ytmp3-backups/dablaja-pre-20260815-0138.tgz` created before overwrite |
| Service health | PASS — `ytmp3-api` active on `127.0.0.1:8080` after restart |
| Public landing | PASS — `https://audiofetcher.com/dablaja/` returns 200 |
| Public privacy / terms | PASS — both HTTPS pages return 200 and are linked from the footer |
| Public stats API | PASS — real zero-state JSON returned; no fabricated totals |
| Usage write restriction | PASS — request without extension origin returns 403; valid extension preflight returns 204 |
| Visual desktop QA | PASS — 1440px Chrome render, real popup asset, supplied globe/chart assets, no broken images, no horizontal overflow |
| Console | PASS — no warnings or errors on the deployed page |
| Demo modal | PASS — button close and backdrop close pause media immediately; reopening plays with `readyState=4` and no media error |

## Installed extension / live API status

| Scenario | Status | Evidence / residual item |
|---|---|---|
| Unpacked installation | PASS | Previously loaded and used successfully in the user's Chrome session |
| Valid Gemini dubbing | PASS (prior build) | User confirmed the extension “works great” after the Gemini session protocol fix |
| Real popup/RTL, key controls, volume controls, captions | PASS (prior session) | Previously exercised during the live API debugging session; no key is recorded in this report |
| New anonymous-statistics consent | AUTOMATED PASS / INSTALLED UI RELOAD NEEDED | Message routing, storage, payload, decline path, and withdrawal control pass static/tests; Chrome's protected extension manager could not be controlled by this browser tool, so reload the unpacked extension once to activate this latest code |
| Human listening quality | PARTIAL | Arabic output was confirmed working; exact confirmation for delay, crackling/overlap, and both sliders should be repeated on the release ZIP |
| 15–20 minute sustained run on latest build | NOT REPEATED | Keep as a release-candidate test before Web Store submission |

## Data verification

- No API key, URL, page title, audio, transcript, or persistent user/install identifier is sent in community-usage events.
- Community events contain exactly `event_id`, `platform`, and `dubbed_ms` after opt-in.
- One-time event IDs are retained for deduplication for at most 8 days; daily aggregates power the public page.
- Error diagnostics require the same opt-in and use a per-event random ID and coarse platform category.
- Audio and transcripts continue to travel directly to Google Gemini, never through AudioFetcher.

## Acceptance statement

The landing page, VPS migration, live statistics API, legal pages, and automated extension safeguards are verified. The remaining release-candidate checks are a one-time unpacked-extension reload, a fresh listening confirmation, and a sustained session on the exact packaged build.
