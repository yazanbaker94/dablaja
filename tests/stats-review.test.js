import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('stats page includes the creator review card and bundled avatar', async () => {
  const html = await readFile(path.join(root, 'src', 'stats', 'stats.html'), 'utf8');
  const css = await readFile(path.join(root, 'src', 'stats', 'stats.css'), 'utf8');
  const avatar = await stat(path.join(root, 'src', 'stats', 'yzn.jpg'));

  assert.match(html, /class="card review-card"/);
  assert.match(html, /src="yzn\.jpg"/);
  assert.match(html, /id="reviewCta"/);
  assert.match(html, /<span>أرسل رأيك<\/span>/);
  assert.doesNotMatch(html, /اترك تقييماً/);
  assert.match(await readFile(path.join(root, 'src', 'stats', 'stats.js'), 'utf8'), /reviewCta\?\.addEventListener\('click', openFeedbackPage\)/);
  assert.match(css, /\.review-card-inner\s*\{/);
  assert.match(css, /\.review-card\s*\{[\s\S]*grid-row:\s*2;/);
  assert.match(css, /@keyframes reviewAttention/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.ok(avatar.size > 1000, 'creator avatar should be a real bundled image');
});

test('the Plus card has one tier-aware click path and cannot open checkout for an entitled user', async () => {
  const js = await readFile(path.join(root, 'src', 'stats', 'stats.js'), 'utf8');
  assert.equal(
    [...js.matchAll(/statsUpgradeBtn\?\.addEventListener\('click'/g)].length,
    1,
    'the Plus card should bind exactly one click listener'
  );
  assert.doesNotMatch(js, /statsUpgradeBtn\.onclick\s*=/, 'do not layer an onclick handler over the checkout listener');
  assert.match(js, /if \(statsPlusEnabled\) \{\s*await openLibraryPage\(\);\s*return;/);
});
