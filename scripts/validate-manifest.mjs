import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const expectedPermissions = ['activeTab', 'offscreen', 'sidePanel', 'storage', 'tabCapture'];
const actualPermissions = [...manifest.permissions].sort();
if (manifest.manifest_version !== 3) throw new Error('Manifest must use MV3');
if (JSON.stringify(actualPermissions) !== JSON.stringify(expectedPermissions.sort())) {
  throw new Error(`Unexpected permissions: ${actualPermissions.join(', ')}`);
}
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://generativelanguage.googleapis.com/*'])) {
  throw new Error('Host permissions must be limited to the Gemini endpoint host');
}
if (!manifest.content_security_policy?.extension_pages.includes("script-src 'self'")) throw new Error('Missing self-only script CSP');
if (manifest.content_security_policy.extension_pages.includes("'unsafe-eval'")) throw new Error('unsafe-eval is forbidden');
if (!manifest.content_security_policy.extension_pages.includes('wss://generativelanguage.googleapis.com')) throw new Error('Gemini WSS missing from connect-src');

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon)
];
for (const relative of new Set(referenced)) await access(path.join(root, relative));
process.stdout.write(`Manifest valid; ${new Set(referenced).size} referenced files exist.\n`);
