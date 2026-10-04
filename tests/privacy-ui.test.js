// Privacy guarantees that must hold for the open-source build: no consent
// popups or checkbox friction, a concise Gemini disclosure beside key entry,
// and no developer backend, telemetry or payment code anywhere in the
// shipped extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(full));
    else results.push(full);
  }
  return results;
}

test('popup has a non-blocking Gemini disclosure and no consent controls', async () => {
  const html = await readFile(path.join(root, 'src/popup/popup.html'), 'utf8');
  assert.ok(!html.includes('id="geminiConsent"'), 'Gemini checkbox must be removed');
  assert.ok(html.includes('class="gemini-disclosure"'), 'processing disclosure remains beside the key');
  assert.ok(html.includes('Google Gemini'), 'recipient is named in-product');
  assert.ok(!html.includes('analyticsNotice'), 'analytics consent card must be removed');
  assert.ok(!html.includes('localLibraryConsentCard'), 'local-library consent card must be removed');
  const js = await readFile(path.join(root, 'src/popup/popup.js'), 'utf8');
  assert.ok(!js.includes('geminiConsent'), 'popup script has no consent state machine');
  assert.ok(!js.includes('message.consent'), 'key save has no hidden consent flag');
});

test('popup hides redundant Ready, Stopped, and live-dubbing labels while preserving actionable statuses', async () => {
  const js = await readFile(path.join(root, 'src/popup/popup.js'), 'utf8');
  assert.ok(!js.includes("[STATUS.READY]: 'جاهز للبدء'"));
  assert.ok(!js.includes("[STATUS.STOPPED]: 'متوقف'"));
  assert.ok(!js.includes("[STATUS.TRANSLATING]: 'الدبلجة تعمل'"));
  assert.match(js, /const quietState = \[STATUS\.READY, STATUS\.STOPPED, STATUS\.TRANSLATING\]\.includes\(currentState\.status\)/);
  assert.match(js, /elements\.sessionStatus\.hidden = quietState/);
  assert.match(js, /\[STATUS\.CONNECTING\]: 'جارٍ الاتصال'/,
    'connection progress must remain visible');
  assert.match(js, /\[STATUS\.ERROR\]: 'تحتاج الجلسة إلى انتباه'/,
    'actionable errors must remain visible');
});

test('key saving persists only the local key and no legacy consent timestamps', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  assert.ok(sw.includes('await saveKey(message.apiKey)'), 'SAVE_KEY handler validates the key directly');
  assert.ok(!sw.includes('STORAGE_KEYS.CONSENT'), 'legacy Gemini consent storage is removed');
  assert.ok(!sw.includes('CURRENT_CONSENT_VERSION'), 'legacy consent version gate is removed');
  assert.ok(/validateApiKey\(apiKey\)/.test(sw), 'worker validates the key format');
});

test('local session saving defaults to enabled unless explicitly disabled', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  assert.ok(sw.includes('stored[STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED] !== false'), 'library settings default local saving true');
  assert.ok(sw.includes('localSaving[STORAGE_KEYS.LIBRARY_LOCAL_SAVING_ENABLED] !== false'), 'startSession drafts run unless explicitly disabled');
});

test('local-saving toggle exists in settings and there is no analytics toggle', async () => {
  const html = await readFile(path.join(root, 'src/library/library.html'), 'utf8');
  assert.ok(html.includes('id="localSavingToggle"'), 'local saving toggle present in settings');
  assert.ok(!html.includes('id="analyticsToggle"'), 'telemetry was removed, so no opt-in toggle remains');
});

test('the extension talks only to Gemini and YouTube thumbnails', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://generativelanguage.googleapis.com/*']);
  assert.ok(!manifest.permissions.includes('alarms'), 'no background polling remains');
  const csp = manifest.content_security_policy.extension_pages;
  const connect = csp.match(/connect-src ([^;]+)/)[1].trim().split(/\s+/);
  assert.deepEqual(connect.sort(), [
    "'self'",
    'https://generativelanguage.googleapis.com',
    'wss://generativelanguage.googleapis.com'
  ]);
});

test('no developer backend, telemetry, payment or licensing code ships', async () => {
  const files = (await walk(path.join(root, 'src'))).filter((file) => /\.(js|html|css)$/.test(file));
  const forbidden = /audiofetcher|stripe|checkout|setUninstallURL|license[-_ ]?token|recovery code|install_credential/i;
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (forbidden.test(text)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});
