import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { inspectPng, inspectRgbaAlphaBounds, validateStoreAssets } from '../scripts/validate-store-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('PNG inspector rejects non-PNG data', () => {
  assert.throws(() => inspectPng(Buffer.from('not a png'), 'fixture'), /valid PNG/);
});

test('current icons and promotional assets have exact Store dimensions', async () => {
  const result = await validateStoreAssets(root);
  assert.equal(result.icons, 4);
  assert.equal(result.screenshots, 0);
  assert.match(result.warnings.join('\n'), /real 1280x800 extension experience/);
});

test('128px Store icon artwork stays inside the centered 96px safe area', async () => {
  const bounds = inspectRgbaAlphaBounds(await readFile(path.join(root, 'icons/icon-128.png')), 'icon-128');
  assert.ok(bounds.left >= 16);
  assert.ok(bounds.top >= 16);
  assert.ok(bounds.right <= 112);
  assert.ok(bounds.bottom <= 112);
});

test('release validation refuses to substitute marketing mockups for real screenshots', async () => {
  await assert.rejects(
    validateStoreAssets(root, { release: true }),
    /No submission screenshot exists yet/
  );
});
