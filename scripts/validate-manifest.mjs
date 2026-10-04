import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.default_locale !== 'en') throw new Error('English must be the default Store/package locale');
if (manifest.name !== '__MSG_extName__') throw new Error('Manifest name must use the localized extName message');
if (manifest.description !== '__MSG_extDescription__') throw new Error('Manifest description must use the localized extDescription message');
if (manifest.action?.default_title !== '__MSG_actionTitle__') throw new Error('Action title must use the localized actionTitle message');
for (const locale of ['en', 'ar']) {
  const messages = JSON.parse(await readFile(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
  for (const key of ['extName', 'extDescription', 'actionTitle']) {
    if (!messages[key]?.message?.trim()) throw new Error(`Missing ${key} message for ${locale}`);
  }
  if (messages.extName.message.length > 45) throw new Error(`${locale} extension name exceeds 45 characters`);
  if (messages.extDescription.message.length > 132) throw new Error(`${locale} extension description exceeds 132 characters`);
}
const expectedPermissions = ['activeTab', 'offscreen', 'storage', 'tabCapture'];
const actualPermissions = [...manifest.permissions].sort();
if (manifest.manifest_version !== 3) throw new Error('Manifest must use MV3');
if (JSON.stringify(actualPermissions) !== JSON.stringify(expectedPermissions.sort())) {
  throw new Error(`Unexpected permissions: ${actualPermissions.join(', ')}`);
}
const expectedHosts = ['https://generativelanguage.googleapis.com/*'];
if (JSON.stringify([...manifest.host_permissions].sort()) !== JSON.stringify(expectedHosts.sort())) {
  throw new Error('Host permissions must be limited to the Gemini API');
}
if (!manifest.content_security_policy?.extension_pages.includes("script-src 'self'")) throw new Error('Missing self-only script CSP');
if (manifest.content_security_policy.extension_pages.includes("'unsafe-eval'")) throw new Error('unsafe-eval is forbidden');
if (!manifest.content_security_policy.extension_pages.includes('wss://generativelanguage.googleapis.com')) throw new Error('Gemini WSS missing from connect-src');

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon)
];
// Runtime pages that must ship even though only the manifest references some.
const requiredRuntimeFiles = [
  'src/offscreen/offscreen.html',
  'src/offscreen/offscreen.js',
  'src/worklets/capture-processor.js',
  'src/worklets/playback-processor.js',
  'src/popup/popup.js',
  'src/stats/stats.html',
  'src/stats/stats.js',
  'src/diagnostics/diagnostics.html',
  'src/diagnostics/diagnostics.js',
  'src/library/library.html',
  'src/library/library.js',
  'src/library/library.css'
];
for (const relative of new Set([...referenced, ...requiredRuntimeFiles])) await access(path.join(root, relative));

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.version !== manifest.version) {
  throw new Error(`package.json version ${packageJson.version} != manifest.json version ${manifest.version}`);
}

process.stdout.write(`Manifest valid; ${new Set([...referenced, ...requiredRuntimeFiles]).size} referenced/required files exist.\n`);
