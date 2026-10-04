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

  const elBlock = libJs.slice(libJs.indexOf('const elements = {'), libJs.indexOf('};\n\nlet librarySettings'));
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

test('site profile rows are editable and the empty state explains how they are created', async () => {
  const [libHtml, prevHtml, libJs, libCss] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8'),
    readFile(path.join(root, 'src/library/library.css'), 'utf8')
  ]);

  assert.ok(libJs.includes("LIBRARY_UPDATE_SITE_PROFILE"), 'library.js must send the profile update message');
  assert.ok(libJs.includes('makeProfileVolumeControl'), 'library.js must build volume sliders per profile');

  const profileClasses = [
    'profile-row', 'profile-row-head', 'profile-site',
    'profile-volumes', 'profile-volume', 'profile-volume-name',
    'profile-volume-slider', 'profile-volume-value'
  ];
  for (const cls of profileClasses) {
    assert.ok(libCss.includes(`.${cls}`), `library.css missing .${cls}`);
  }

  const emptyText = 'ستظهر هنا المواقع التي ضبطت صوتها';
  assert.ok(libHtml.includes(emptyText), 'library.html empty state must explain how profiles are created');
  assert.ok(prevHtml.includes(emptyText), 'preview.html empty state must explain how profiles are created');
});

test('emptyCta placeholder button and sample generator are completely removed', async () => {
  const [libHtml, prevHtml, libJs] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8')
  ]);

  assert.ok(!libHtml.includes('id="emptyCta"'), 'library.html must not contain emptyCta');
  assert.ok(!prevHtml.includes('id="emptyCta"'), 'preview.html must not contain emptyCta');
  assert.ok(!libJs.includes('generateSampleSessions'), 'library.js must not contain generateSampleSessions');
  assert.ok(!libJs.includes('emptyCta'), 'library.js must not contain emptyCta');
});

test('library has no paid-tier, checkout, license or telemetry surfaces', async () => {
  const [libHtml, prevHtml, libJs, libCss] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8'),
    readFile(path.join(root, 'src/library/library.css'), 'utf8')
  ]);

  const removedIds = [
    'topPlusBadge', 'lockedNotice', 'freeTierUpgradeBanner', 'upgradeTopBtn', 'activateTopBtn',
    'headImportPlusBadge', 'importPlusBadge', 'plusUpgradeBlock', 'libUpgradeBtn',
    'openActivationBtn', 'plusActiveActions', 'rotateRecoveryBtn', 'activationModal',
    'modalUpgradeCheckoutBtn', 'activationInput', 'activationSubmit', 'rotateRecoveryModal',
    'analyticsToggle', 'plusCard', 'plusState'
  ];
  for (const html of [libHtml, prevHtml]) {
    for (const id of removedIds) {
      assert.ok(!html.includes(`id="${id}"`), `removed element #${id} must stay out of the page`);
    }
    assert.doesNotMatch(html, /Plus/, 'no user-visible "Plus" branding');
    assert.doesNotMatch(html, /audiofetcher|stripe|10\$|\$10|ترقية|ترخيص|رمز الاسترداد/i,
      'no pricing, payment, license or third-party backend copy');
    assert.match(html, /<title>dablaja — مكتبة الجلسات<\/title>/);
    assert.match(html, /Google Gemini/, 'privacy copy names the direct Gemini path');
    assert.match(html, /IndexedDB/, 'privacy copy says saved transcripts stay local');
    assert.match(html, /i\.ytimg\.com/, 'privacy copy names the thumbnail host');
  }

  assert.doesNotMatch(libJs,
    /plusEnabled|entitlement|lockRealCard|triggerCheckout|PLUS_START_CHECKOUT|PLUS_RECOVER_LICENSE|PLUS_ROTATE_RECOVERY|SET_ANALYTICS_CONSENT|RECOVERY_CODE_PATTERN|createRotationController|#activate/,
    'library.js must not keep dead tier, checkout, license or telemetry code');
  assert.doesNotMatch(libCss,
    /\.plus-badge-btn|\.free-limit-|\.plus-real-|\.plus-locked-|\.plus-inline-badge|is-tier-locked|\.modal-upgrade-card|\.activation-|\.btn-modal-upgrade-cta|\.about-plus-/,
    'dead paywall CSS must be removed');
});

test('audio settings and site profiles are connected to extension sound settings', async () => {
  const [libHtml, prevHtml, libJs, libCss, swJs] = await Promise.all([
    readFile(path.join(root, 'src/library/library.html'), 'utf8'),
    readFile(path.join(root, 'src/library/preview.html'), 'utf8'),
    readFile(path.join(root, 'src/library/library.js'), 'utf8'),
    readFile(path.join(root, 'src/library/library.css'), 'utf8'),
    readFile(path.join(root, 'src/service-worker.js'), 'utf8')
  ]);

  for (const id of ['autoDuckingToggle', 'rememberVolumesToggle', 'profileList', 'noProfiles']) {
    assert.ok(libHtml.includes(`id="${id}"`), `library.html missing id="${id}"`);
    assert.ok(prevHtml.includes(`id="${id}"`), `preview.html missing id="${id}"`);
    assert.ok(libJs.includes(id), `library.js missing ${id}`);
  }

  assert.ok(!libHtml.includes('id="dubbedDefaultVolume"'), 'library.html must not have redundant dubbedDefaultVolume');
  assert.ok(!libHtml.includes('id="originalDefaultVolume"'), 'library.html must not have redundant originalDefaultVolume');

  assert.ok(libJs.includes("type: 'LIBRARY_UPDATE_SITE_PROFILE'"), 'library.js must send LIBRARY_UPDATE_SITE_PROFILE');
  assert.ok(libJs.includes("type: 'SET_AUTO_DUCKING'"), 'library.js must send SET_AUTO_DUCKING');

  // SW profile update / delete syncs active audio session
  assert.ok(swJs.includes('state.tabOrigin === origin'), 'SW must check active origin for live sync');
  assert.ok(swJs.includes("target: 'offscreen'"), 'SW must forward SET_VOLUME to offscreen audio');
});
