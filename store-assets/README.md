# Chrome Web Store assets

This directory contains only files intended for the Chrome Web Store dashboard.
It is deliberately excluded from the extension ZIP.

## Ready

- `small-promo-440x280.png`: required small promotional tile.
- `marquee-1400x560.png`: optional marquee promotional image.
- The Store icon is `icons/icon-128.png`; its visible artwork is constrained to
  the centered 96x96 safe area with 16px transparent padding. The manifest also
  ships exact 16, 32, and 48 pixel variants.

The two promotional graphics were generated with the built-in image-generation
tool from the existing Dablaja logo mark and seated mascot. The production
prompt requested a full-bleed navy/teal software-brand composition with no
text, price, rating, badge, browser UI, Google/Chrome mark, or product claim.
They are promotional art, not product screenshots.

## Still required

Add between one and five **real** current-product screenshots to `screenshots/`.
Use descriptive ordered names such as `01-live-dubbing.png`. Each file must be
PNG at 1280x800 (preferred) or 640x400. Before approval, verify that it:

- shows the actual extension version being submitted;
- contains no Gemini key, private caption, account detail, or sensitive tab;
- uses current Dablaja UI and truthful Free/Plus limits;
- is sharp, full bleed, and has square corners;
- does not fabricate reviews, user counts, performance, or Store status.

The eight files in `store-images/` are visual references and AI mockups. They
are not submission screenshots and must not be uploaded as proof of the real
extension experience.

Run `npm run validate` to check dimensions. Release validation intentionally
fails until at least one real screenshot is present.
