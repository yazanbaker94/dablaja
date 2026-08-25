import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DOM element existence and accessible attribute audit; the behavioral
// coverage (open/close, confirmation, double-click, clipboard,
// Arabic errors, Escape, beforeunload memory wipe, storage absence) is now
// exercised against the REAL production controller in
// tests/rotation-controller.test.js. This file retains only the static check.
test('recovery rotation UI elements exist in both library.html and preview.html with required accessible attributes', async () => {
  const [libHtml, prevHtml, libJs] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8')
  ]);

  const requiredIds = [
    'plusActiveActions',
    'rotateRecoveryBtn',
    'rotateRecoveryModal',
    'rotateRecoveryTitle',
    'rotateConfirmStep',
    'rotateResultStep',
    'rotateConfirmBtn',
    'rotateCancelBtn',
    'rotateResultCode',
    'rotateCopyBtn',
    'rotateCloseBtn',
    'rotateStatus'
  ];

  for (const id of requiredIds) {
    assert.ok(libHtml.includes(`id="${id}"`), `library.html missing id="${id}"`);
    assert.ok(prevHtml.includes(`id="${id}"`), `preview.html missing id="${id}"`);
    assert.ok(libJs.includes(`${id}:`), `library.js missing element binding for "${id}"`);
  }

  // Accessibility checks
  assert.ok(libHtml.includes('role="dialog"'), 'library.html modal must have role="dialog"');
  assert.ok(libHtml.includes('aria-modal="true"'), 'library.html modal must have aria-modal="true"');
  assert.ok(libHtml.includes('aria-labelledby="rotateRecoveryTitle"'), 'library.html modal must have aria-labelledby');
  assert.ok(prevHtml.includes('role="dialog"'), 'preview.html modal must have role="dialog"');
  assert.ok(prevHtml.includes('aria-modal="true"'), 'preview.html modal must have aria-modal="true"');
  assert.ok(prevHtml.includes('aria-labelledby="rotateRecoveryTitle"'), 'preview.html modal must have aria-labelledby');

  // Verify code box is dir="ltr" and user-select:all for clean copying
  assert.ok(libHtml.includes('dir="ltr"'), 'rotateResultCode must be dir="ltr"');
  assert.ok(libHtml.includes('user-select:all'), 'rotateResultCode should have user-select:all');
});
