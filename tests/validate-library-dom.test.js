import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('library.html and preview.html contain all elements bound in library.js', async () => {
  const [libHtml, prevHtml, libJs, libCss] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8'),
    readFile(path.join(root, 'src/library/library.css'), 'utf8')
  ]);

  const elBlock = libJs.slice(libJs.indexOf('const elements = {'), libJs.indexOf('};\n\nlet plusSettings'));
  const elIds = [...elBlock.matchAll(/([a-zA-Z0-9_]+):\s*\$\('([a-zA-Z0-9_]+)'\)/g)].map((m) => m[2]);

  assert.ok(elIds.length >= 30, 'Should find element IDs');

  for (const id of elIds) {
    assert.ok(libHtml.includes(`id="${id}"`), `library.html missing id="${id}"`);
    assert.ok(prevHtml.includes(`id="${id}"`), `preview.html missing id="${id}"`);
  }

  const requiredClasses = [
    'detail-top-nav', 'btn-ghost-s', 'btn-ghost-danger-s', 'detail-actions',
    'detail-head', 'detail-title', 'detail-meta', 'detail-layout',
    'detail-main', 'transcript-head', 'transcript-search', 'transcript-scroll',
    't-row', 't-time', 't-text', 'detail-side', 'side-panel', 'section-title',
    'notes-area', 'notes-status', 'bookmarks-scroll', 'bookmark-item', 'panel-empty'
  ];

  for (const cls of requiredClasses) {
    assert.ok(libCss.includes(`.${cls}`), `library.css missing .${cls}`);
  }
});
