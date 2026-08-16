# dablaja landing page

This is a static, Arabic-first landing page for dablaja. It intentionally keeps the visual system in HTML/CSS/SVG-like CSS primitives and uses the real extension captures for the product UI.

## Preview locally

From the repository root:

```powershell
python -m http.server 4173 --directory landing
```

Then open `http://localhost:4173`.

The hero poster is taken from the real toolbar-click sequence, with the extension popup fully visible. Selecting the play control opens the complete demonstration inside the page with sound, native playback controls, seeking, and fullscreen support. The optimized file is `landing/assets/demo-full.mp4`: a 58.8-second H.264/AAC edit that removes the silent lead-in and retains the Arabic dubbing demonstration plus the dashboard ending. Audio and video are trimmed by the same 2.6 seconds and otherwise keep the source recording's original relative timing. Sound starts only after the visitor clicks, as required by browser autoplay rules. Closing the dialog by button, backdrop, Escape, navigation, or tab hiding stops and resets all landing-page video playback.

## Asset notes

- `dablaja-wordmark.png`, `popup-ready-real.png`, `popup-active-real.png`, and `stats.png` are real project assets.
- `popup-ready-real.png` appears in the middle how-it-works card. The navy product card combines the real active sound controls with the product wordmark so the separate crossed-arms mascot does not duplicate the mascot inside the screenshot.
- `dablaja-toolbar-mark.png` is the original high-resolution standalone mark used in the toolbar callout.
- Mascot poses are named by placement: `mascot-crossed-arms.png` (navy product section), `mascot-cta-presenting.png` (final CTA), and `mascot-pointing.png` (optional future callout).
- No invented review counts, ratings, or customer logos are used.
- The install CTA points to the local unpacked-install instructions until a Chrome Web Store listing exists.
