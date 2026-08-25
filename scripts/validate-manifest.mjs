import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUS_DEV_PREVIEW_ENABLED } from '../src/shared/plus-entitlement.js';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const expectedPermissions = ['activeTab', 'alarms', 'offscreen', 'sidePanel', 'storage', 'tabCapture'];
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
  const blockers = [];
  if (PLUS_DEV_PREVIEW_ENABLED) {
    blockers.push('PLUS_DEV_PREVIEW_ENABLED is still true in src/shared/plus-entitlement.js');
  }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.version !== manifest.version) {
    blockers.push(`package.json version ${packageJson.version} != manifest.json version ${manifest.version}`);
  }
  if (manifest.version !== '1.0.0' || packageJson.version !== '1.0.0') {
    blockers.push('Version must be 1.0.0 everywhere (manifest, package, docs)');
  }
  // Check runtime static Stripe link
  const popupJs = await readFile(path.join(root, 'src/popup/popup.js'), 'utf8');
  const libraryJs = await readFile(path.join(root, 'src/library/library.js'), 'utf8');
  const statsJs = await readFile(path.join(root, 'src/stats/stats.js'), 'utf8');
  const swJs = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  for (const [name, content] of [['popup.js', popupJs], ['library.js', libraryJs], ['stats.js', statsJs], ['service-worker.js', swJs]]) {
    if (content.includes('buy.stripe.com') || content.includes('STRIPE_PAYMENT_LINK')) {
      blockers.push(`Runtime static Stripe link found in ${name} (must use POST /api/checkout)`);
    }
  }
  // Legacy entitlement verifier
  const entJs = await readFile(path.join(root, 'src/shared/plus-entitlement.js'), 'utf8');
  if (entJs.includes("VERIFIER_SOURCES") && entJs.includes("entitlement_endpoint")) {
    blockers.push('Legacy entitlement_endpoint verifier still present in plus-entitlement.js (must be removed)');
  }
  // Email/pi activation in server
  const serverPy = await readFile(path.join(root, 'server/dablaja.py'), 'utf8');
  if (serverPy.includes('verify-license') && serverPy.includes('clean_query.startswith("pi_")')) {
    blockers.push('Insecure email/pi_* activation still present in server/dablaja.py');
  }
  // Hand-rolled webhook
  if (serverPy.includes('_verify_stripe_signature') && !serverPy.includes('stripe.Webhook.construct_event')) {
    blockers.push('Hand-rolled Stripe webhook verification still present (must use stripe.Webhook.construct_event)');
  }
  // Missing secure checkout route
  if (!serverPy.includes('"/dablaja/api/checkout"') || !serverPy.includes('dablaja_api_checkout')) {
    blockers.push('Missing secure POST /dablaja/api/checkout route in server/dablaja.py');
  }
  // Stale privacy/doc versions
  const privacyMd = await readFile(path.join(root, 'PRIVACY.md'), 'utf8');
  if (!privacyMd.includes('1.0.0')) blockers.push('PRIVACY.md version not 1.0.0');
  const privacyHtml = await readFile(path.join(root, 'privacy.html'), 'utf8');
  if (!privacyHtml.includes('1.0.0')) blockers.push('privacy.html version not 1.0.0');
  try {
    const landingPrivacy = await readFile(path.join(root, 'landing/privacy.html'), 'utf8');
    if (!landingPrivacy.includes('1.0.0')) blockers.push('landing/privacy.html version not 1.0.0');
  } catch {}
  // Development-preview/payment-not-connected text
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  if (readme.includes('payment not connected') || readme.includes('الدفع غير مربوط')) {
    blockers.push('README.md still contains development-preview/payment-not-connected text');
  }
  const storeListing = await readFile(path.join(root, 'STORE_LISTING.md'), 'utf8');
  if (storeListing.includes('قيد التطوير') || storeListing.includes('الدفع غير مربوط')) {
    blockers.push('STORE_LISTING.md still contains development-preview text');
  }
  // Missing public license key
  const pubKey = (await readFile(path.join(root, 'src/shared/plus-entitlement.js'), 'utf8')).match(/PLUS_LICENSE_PUBLIC_KEY_B64\s*=\s*'([^']+)'/);
  if (!pubKey || !pubKey[1] || pubKey[1].length < 40) {
    blockers.push('Missing production public license key PLUS_LICENSE_PUBLIC_KEY_B64');
  }
  // Release acceptance is content-gated, not presence-gated. A stale or
  // pre-created file must never authorize a Store upload by itself.
  try {
    const acceptance = await readFile(path.join(root, 'RELEASE_ACCEPTANCE.md'), 'utf8');
    if (!/^\*\*Decision:\*\* APPROVED\s*$/m.test(acceptance)) {
      blockers.push('RELEASE_ACCEPTANCE.md decision is not APPROVED');
    }
    for (const marker of [
      'Human listening: PASS',
      'Sustained session: PASS',
      'VPS signing key: PASS',
      'Stripe webhook: PASS',
      'Store extension origin: PASS',
      'Clean-profile ZIP: PASS'
    ]) {
      if (!acceptance.includes(marker)) blockers.push(`Missing release evidence marker: ${marker}`);
    }
  } catch {
    blockers.push('Missing RELEASE_ACCEPTANCE.md (manual acceptance required)');
  }
  // Manual checklist unchecked
  try {
    const checklist = await readFile(path.join(root, 'RELEASE_CHECKLIST.md'), 'utf8');
    const unchecked = (checklist.match(/- \[ \]/g) || []).length;
    if (unchecked > 0) blockers.push(`RELEASE_CHECKLIST.md has ${unchecked} unchecked manual items`);
  } catch {}
  // Product copy unbounded
  for (const file of ['src/library/library.html','src/popup/popup.html','src/stats/stats.html']) {
    try {
      const html = await readFile(path.join(root, file), 'utf8');
      if (html.includes('غير المحدود') || html.includes('بلا حدود') || html.includes('unlimited')) {
        blockers.push(`Unbounded claim still present in ${file}`);
      }
      if (html.includes('للوصول .') || html.includes('حتى 500 جلسة (حتى 500)')) {
        blockers.push(`Malformed replacement fragment still present in ${file}`);
      }
    } catch {}
  }
  if (blockers.length) {
    throw new Error('Release build refused — blockers:\n- ' + blockers.join('\n- '));
  }
}
if (PLUS_DEV_PREVIEW_ENABLED) {
  process.stdout.write('WARNING: Plus development-preview entitlement is ENABLED — do not publish this build.\n');
}

process.stdout.write(`Manifest valid; ${new Set([...referenced, ...requiredRuntimeFiles]).size} referenced/required files exist.\n`);
