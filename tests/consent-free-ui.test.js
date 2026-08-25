// Release gate: no consent popups or checkbox friction. A concise disclosure
// remains adjacent to key entry and analytics stays explicit opt-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('popup has a non-blocking Gemini disclosure and no consent controls', async () => {
  const html = await readFile(path.join(root, 'src/popup/popup.html'), 'utf8');
  assert.ok(!html.includes('id="geminiConsent"'), 'Gemini checkbox must be removed');
  assert.ok(html.includes('class="gemini-disclosure"'), 'processing disclosure remains beside the key');
  assert.ok(html.includes('Google Gemini'), 'recipient is named in-product');
  assert.ok(html.includes('AudioFetcher'), 'developer-server exclusion is stated in-product');
  assert.ok(!html.includes('analyticsNotice'), 'analytics consent card must be removed');
  assert.ok(!html.includes('localLibraryConsentCard'), 'local-library consent card must be removed');
  assert.ok(!html.includes('acceptAnalytics'), 'accept button must be removed');
  assert.ok(!html.includes('declineAnalytics'), 'decline button must be removed');
  assert.ok(!html.includes('changeAnalytics'), 'stats-sharing re-prompt button must be removed');
  const js = await readFile(path.join(root, 'src/popup/popup.js'), 'utf8');
  assert.ok(!js.includes('geminiConsent'), 'popup script has no consent state machine');
  assert.ok(!js.includes('message.consent'), 'key save has no hidden consent flag');
  assert.ok(!js.includes('SET_ANALYTICS_CONSENT'), 'popup must not host the consent decision anymore');
});

test('key saving persists only the local key and no legacy consent timestamps', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  assert.ok(sw.includes('await saveKey(message.apiKey)'), 'SAVE_KEY handler validates the key directly');
  assert.ok(!sw.includes('STORAGE_KEYS.CONSENT'), 'legacy Gemini consent storage is removed');
  assert.ok(!sw.includes('CURRENT_CONSENT_VERSION'), 'legacy consent version gate is removed');
  assert.ok(/validateApiKey\(apiKey\)/.test(sw), 'worker validates the key format');
});

test('anonymous stats remain disabled until explicitly enabled', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  assert.ok(sw.includes('stored[STORAGE_KEYS.ANALYTICS_CONSENT] === true'), 'settings must treat missing decision as opted-out');
  const telemetry = await readFile(path.join(root, 'src/shared/telemetry.js'), 'utf8');
  assert.ok(telemetry.includes("stored[STORAGE_KEYS.ANALYTICS_CONSENT] !== true"), 'telemetry requires explicit opt-in');
});

test('local session saving defaults to enabled unless explicitly disabled', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  assert.ok(sw.includes('stored[STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED] !== false'), 'Plus settings default local saving true');
  assert.ok(sw.includes('localSaving[STORAGE_KEYS.PLUS_LOCAL_SAVING_ENABLED] !== false'), 'startSession drafts run unless explicitly disabled');
});

test('local-saving and opt-in analytics toggles exist in settings without being popups', async () => {
  const html = await readFile(path.join(root, 'src/library/library.html'), 'utf8');
  assert.ok(html.includes('id="analyticsToggle"'), 'anonymous stats toggle present in settings');
  assert.ok(html.includes('id="localSavingToggle"'), 'local saving toggle present in settings');
});

test('statistics copy accurately distinguishes local detail from opt-in aggregates', async () => {
  const statsHtml = await readFile(path.join(root, 'src/stats/stats.html'), 'utf8');
  const landingHtml = await readFile(path.join(root, 'landing/index.html'), 'utf8');
  assert.match(statsHtml, /تفاصيل هذه الصفحة محلية/);
  assert.match(statsHtml, /عند تفعيل المشاركة/);
  assert.match(landingHtml, /المستخدمين الذين اختاروا المشاركة/);
});

test('error telemetry omits the stable licensing installation identity', async () => {
  const telemetry = await readFile(path.join(root, 'src/shared/telemetry.js'), 'utf8');
  assert.equal(/install_id:\s*await ensureInstallId\(\)/.test(telemetry), false, 'error payload must not carry install_id');
  assert.ok(/install_id'/.test(await readFile(path.join(root, 'tests/telemetry-allowlist.test.js'), 'utf8')), 'allowlist test pins install_id');
});

test('feedback and uninstall links never expose a persistent install identifier', async () => {
  const telemetry = await readFile(path.join(root, 'src/shared/telemetry.js'), 'utf8');
  const uninstall = telemetry.slice(telemetry.indexOf('export async function configureUninstallUrl'), telemetry.indexOf('export async function feedbackPageUrl'));
  const feedback = telemetry.slice(telemetry.indexOf('export async function feedbackPageUrl'), telemetry.indexOf('function siteHost'));
  assert.ok(!uninstall.includes('install_id'));
  assert.ok(!feedback.includes('install_id'));
});
