import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { youtubeThumbnailUrl, youtubeVideoId } from '../src/shared/youtube-thumbnail.js';

const root = path.resolve(import.meta.dirname, '..');

test('YouTube video ids are derived only from allowlisted URL shapes', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=arj7oStGLkU'), 'arj7oStGLkU');
  assert.equal(youtubeVideoId('https://youtu.be/arj7oStGLkU?t=14'), 'arj7oStGLkU');
  assert.equal(youtubeVideoId('https://m.youtube.com/shorts/arj7oStGLkU'), 'arj7oStGLkU');
  assert.equal(youtubeVideoId('https://www.youtube-nocookie.com/embed/arj7oStGLkU'), 'arj7oStGLkU');
  assert.equal(youtubeVideoId('https://www.youtube.com/live/arj7oStGLkU?feature=share'), 'arj7oStGLkU');
});

test('YouTube thumbnail derivation rejects unsafe and lookalike URLs', () => {
  assert.equal(
    youtubeThumbnailUrl('https://www.youtube.com/watch?v=arj7oStGLkU'),
    'https://i.ytimg.com/vi/arj7oStGLkU/hqdefault.jpg'
  );
  assert.equal(youtubeThumbnailUrl('https://youtube.example/watch?v=arj7oStGLkU'), '');
  assert.equal(youtubeThumbnailUrl('https://evilyoutube.com/watch?v=arj7oStGLkU'), '');
  assert.equal(youtubeThumbnailUrl('https://user:pass@youtube.com/watch?v=arj7oStGLkU'), '');
  assert.equal(youtubeThumbnailUrl('javascript:alert(1)'), '');
  assert.equal(youtubeThumbnailUrl('https://youtube.com/watch?v=../../secret'), '');
});

test('library uses real YouTube thumbnails and every saved item is fully accessible', async () => {
  const library = await readFile(path.join(root, 'src/library/library.js'), 'utf8');
  assert.match(library, /youtubeThumbnailUrl\(session\?\.pageUrl\)/);
  assert.match(library, /img\.referrerPolicy = 'no-referrer'/);
  assert.match(library, /img\.src = 'assets\/thumbnail-fallback\.png'/,
    'a failed remote thumbnail must fall back to the bundled image');

  // No tier wrapper: sessions, moments and site profiles render as-is.
  assert.doesNotMatch(library, /lockRealCard|plusEnabled|isPlus|freeSessionId|is-tier-locked/);
  assert.match(library, /results\.map\(\(session\) => sessionCard\(sessionSummary\(session\), session\)\)/);
  assert.match(library, /elements\.momentsList\.append\(card\)/);
  assert.match(library, /elements\.profileList\.append\(li\)/);

  // Import is available to everyone: the menu item opens the file picker directly.
  assert.match(library, /elements\.headImport\.addEventListener\('click', \(\) => \{\s*closeAllDropdowns\(\);\s*elements\.importFile\.click\(\);/);

  const reloadStart = library.indexOf('async function reloadAll()');
  const reloadEnd = library.indexOf('\n}', reloadStart);
  const reloadBody = library.slice(reloadStart, reloadEnd);
  assert.ok(reloadBody.indexOf("send({ type: 'LIBRARY_GET_STATUS' })") < reloadBody.indexOf('renderList()'),
    'library settings must load before cards render');
});

test('remote thumbnail CSP is image-only and does not broaden executable or connect hosts', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /img-src 'self' data: https:\/\/i\.ytimg\.com/);
  assert.doesNotMatch(csp, /connect-src[^;]*ytimg/);
  assert.doesNotMatch(csp, /script-src[^;]*https:/);
  assert.ok(!manifest.host_permissions.includes('https://i.ytimg.com/*'),
    'passive images do not require a new host permission');
});

test('service worker stores up to 50 site profiles for everyone', async () => {
  const [worker, limits] = await Promise.all([
    readFile(path.join(root, 'src/service-worker.js'), 'utf8'),
    import('../src/shared/library-session.js').then((mod) => mod.LIBRARY_LIMITS)
  ]);
  assert.equal(limits.MAX_SITE_PROFILES, 50);
  assert.match(worker, /LIBRARY_LIMITS\.MAX_SITE_PROFILES/);
  assert.match(worker, /upsertProfile\(current\.siteProfiles,[\s\S]*?\}, maxProfiles\)/);
  assert.match(worker, /!exists && librarySettings\.siteProfiles\.length >= maxProfiles/);
  assert.doesNotMatch(worker, /limitReached:\s*true|upgradeRequired:\s*true/);
  assert.match(worker, /error\.code = 'site_profile_limit'/);
});
