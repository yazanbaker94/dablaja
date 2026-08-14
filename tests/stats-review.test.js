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
  assert.match(css, /\.review-card-inner\s*\{/);
  assert.match(css, /\.review-card\s*\{[\s\S]*grid-row:\s*2;/);
  assert.match(css, /@keyframes reviewAttention/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.ok(avatar.size > 1000, 'creator avatar should be a real bundled image');
});
