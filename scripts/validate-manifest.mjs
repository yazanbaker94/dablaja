import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUS_DEV_PREVIEW_ENABLED } from '../src/shared/plus-entitlement.js';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const expectedPermissions = ['activeTab', 'offscreen', 'sidePanel', 'storage', 'tabCapture'];
const actualPermissions = [...manifest.permissions].sort();
if (manifest.manifest_version !== 3) throw new Error('Manifest must use MV3');
if (JSON.stringify(actualPermissions) !== JSON.stringify(expectedPermissions.sort())) {
  throw new Error(`Unexpected permissions: ${actualPermissions.join(', ')}`);
}
const expectedHosts = [
  'https://generativelanguage.googleapis.com/*',
  'https://audiofetcher.com/*'
];
if (JSON.stringify([...manifest.host_permissions].sort()) !== JSON.stringify(expectedHosts.sort())) {
  throw new Error('Host permissions must be limited to Gemini and the disclosed Dablaja service');
}
if (!manifest.content_security_policy?.extension_pages.includes("script-src 'self'")) throw new Error('Missing self-only script CSP');
if (manifest.content_security_policy.extension_pages.includes("'unsafe-eval'")) throw new Error('unsafe-eval is forbidden');
if (!manifest.content_security_policy.extension_pages.includes('wss://generativelanguage.googleapis.com')) throw new Error('Gemini WSS missing from connect-src');
if (!manifest.content_security_policy.extension_pages.includes('https://audiofetcher.com')) throw new Error('Dablaja HTTPS endpoint missing from connect-src');

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.side_panel.default_path,
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
  'src/sidepanel/sidepanel.js',
  'src/stats/stats.html',
  'src/stats/stats.js',
  'src/diagnostics/diagnostics.html',
  'src/diagnostics/diagnostics.js',
  'src/library/library.html',
  'src/library/library.js',
  'src/library/library.css'
];
for (const relative of new Set([...referenced, ...requiredRuntimeFiles])) await access(path.join(root, relative));

// Release gate: a publishable build must never carry the Plus development
// preview entitlement, and manifest/package versions must stay in sync.
// Set DABLAJA_RELEASE=1 via `npm run package:release`.
if (process.env.DABLAJA_RELEASE === '1') {
  if (PLUS_DEV_PREVIEW_ENABLED) {
    throw new Error('Release build refused: PLUS_DEV_PREVIEW_ENABLED is still true in src/shared/plus-entitlement.js');
  }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.version !== manifest.version) {
    throw new Error(`Release build refused: package.json version ${packageJson.version} != manifest.json version ${manifest.version}`);
  }
}
if (PLUS_DEV_PREVIEW_ENABLED) {
  process.stdout.write('WARNING: Plus development-preview entitlement is ENABLED — do not publish this build.\n');
}

process.stdout.write(`Manifest valid; ${new Set([...referenced, ...requiredRuntimeFiles]).size} referenced/required files exist.\n`);
