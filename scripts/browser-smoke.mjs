// Release smoke test: boots real Chrome with the unpacked extension and
// exercises every surface end-to-end (popup, library/settings, stats,
// sidepanel, diagnostics), failing on any console/page error or broken flow.
// Usage: node scripts/browser-smoke.mjs
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { existsSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const visualDir = mkdtempSync(path.join(os.tmpdir(), 'dablaja-extension-visual-'));
console.log(`visual screenshots: ${visualDir}`);

// Chrome's --load-extension mishandles paths containing spaces; stage the
// extension to a space-free directory before loading it.
const stage = path.join(os.tmpdir(), 'dablaja-smoke-ext');
rmSync(stage, { recursive: true, force: true });
cpSync(root, stage, {
  recursive: true,
  filter: (src) => !/(^|\\|\/)(node_modules|\.git|dist|tests|server|landing|docs|promo|recordings|browser-test-output|design images|store-images|preview-1440|preview-plus-1440)(\\|\/|$)/.test(src)
    && !/\.(md|ps1|py|mjs|zip)$/.test(src)
});

// Chrome stable (137+) ignores --load-extension, so prefer Chromium-family
// browsers that still honor it for automated unpacked loading.
const BROWSER_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome Beta/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].filter(Boolean);

const browser = await puppeteer.launch({
  executablePath: BROWSER_PATHS.find((candidate) => existsSync(candidate)) || BROWSER_PATHS[0],
  headless: false,
  args: [
    `--disable-extensions-except=${stage}`,
    `--load-extension=${stage}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider'
  ]
});

const failures = [];
function check(name, condition, detail = '') {
  if (condition) console.log(`ok - ${name}`);
  else {
    console.log(`FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
    failures.push(name);
  }
}

try {
  // Wait for the service worker to discover the extension id.
  const swTarget = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().includes('chrome-extension://'),
    { timeout: 15000 }
  );
  const extensionId = new URL(swTarget.url()).host;
  console.log(`extension loaded: ${extensionId}`);
  const base = `chrome-extension://${extensionId}`;

  async function openPage(urlPath) {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
    });
    await page.goto(`${base}/${urlPath}`, { waitUntil: 'load' });
    return { page, problems };
  }

  // ---- Popup ----
  {
    const { page, problems } = await openPage('src/popup/popup.html');
    await page.setViewport({ width: 420, height: 780, deviceScaleFactor: 1 });
    await page.waitForSelector('#startStop', { timeout: 5000 });
    await page.screenshot({ path: path.join(visualDir, 'popup-ready.png'), fullPage: true });
    check('popup: start button renders', true);
    const disclosure = await page.evaluate(() => ({
      staticDisclosure: Boolean(document.querySelector('.gemini-disclosure')),
      checkbox: Boolean(document.querySelector('#geminiConsent')),
      analyticsPopup: Boolean(document.querySelector('#analyticsNotice')),
      localSavingPopup: Boolean(document.querySelector('#localLibraryConsentCard'))
    }));
    check('popup: concise Gemini disclosure exists without a checkbox gate',
      disclosure.staticDisclosure && !disclosure.checkbox, JSON.stringify(disclosure));
    check('popup: no analytics/local-saving consent popups',
      !disclosure.analyticsPopup && !disclosure.localSavingPopup, JSON.stringify(disclosure));

    // Keyboard-accessible upgrade dialog: labelled copy, focus containment,
    // Escape dismissal, and focus restoration to its opener.
    await page.click('#topUpgradeBadge');
    const popupDialogOpen = await page.evaluate(() => {
      const dialog = document.querySelector('#upgradeModal');
      return !dialog.classList.contains('hidden')
        && dialog.getAttribute('aria-describedby') === 'upgradeModalBody'
        && document.activeElement?.id === 'upgradeCheckoutBtn';
    });
    check('popup: upgrade dialog opens labelled with initial focus', popupDialogOpen);
    await page.focus('#dismissUpgradeBtn');
    await page.keyboard.press('Tab');
    const popupTrap = await page.evaluate(() => document.activeElement?.id === 'modalCloseX');
    check('popup: upgrade dialog traps Tab focus', popupTrap);
    await page.keyboard.press('Escape');
    const popupDialogClosed = await page.evaluate(() =>
      document.querySelector('#upgradeModal').classList.contains('hidden')
      && document.activeElement?.id === 'topUpgradeBadge');
    check('popup: Escape closes upgrade dialog and restores focus', popupDialogClosed);

    // A well-formed key saves directly; the disclosure remains visible and
    // audio is not transmitted until the separate Start action.
    await page.click('#openKey');
    await page.type('#apiKey', 'AIzaSmokeTestKey0000000000000000000');
    await page.click('#saveKey');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const savedState = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      return { hasKey: response?.settings?.hasKey, status: response?.state?.status, analytics: response?.settings?.analyticsConsent };
    });
    check('popup: SAVE_KEY persists the local key without a consent popup', savedState.hasKey === true, JSON.stringify(savedState));
    check('settings: anonymous analytics defaults to off', savedState.analytics === false, String(savedState.analytics));
    const readyStatus = ['ready', 'stopped'].includes(savedState.status);
    check('popup: state transitions past NO_KEY after save', readyStatus, savedState.status);

    // Volume slider round-trip.
    await page.click('#openAudio');
    await page.$eval('#dubbedVolume', (el) => {
      el.value = '120';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const volume = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      return response?.settings?.dubbedVolume;
    });
    check('popup: SET_VOLUME round-trips (1.2)', Math.abs(volume - 1.2) < 0.001, String(volume));
    await page.screenshot({ path: path.join(visualDir, 'popup-audio.png'), fullPage: true });

    check('popup: no console/page errors', problems.length === 0, problems.join(' | '));
    await page.close();
  }

  // ---- Library / settings ----
  {
    const { page, problems } = await openPage('src/library/library.html');
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.waitForSelector('#sessionGrid', { timeout: 5000 });
    check('library: grid renders', true);
    const navCount = await page.$$eval('.nav-btn', (nodes) => nodes.length);
    check('library: 5 sidebar sections', navCount === 5, String(navCount));

    // Settings view: toggles wired to real worker settings. DOM-level click —
    // the sidebar button can sit outside the viewport in automation windows.
    await page.evaluate(() => document.querySelector('[data-nav="settings"]').click());
    await new Promise((resolve) => setTimeout(resolve, 700));
    const toggles = await page.evaluate(() => ({
      analytics: document.querySelector('#analyticsToggle') instanceof HTMLInputElement,
      local: document.querySelector('#localSavingToggle') instanceof HTMLInputElement,
      remember: document.querySelector('#rememberVolumesToggle') instanceof HTMLInputElement
    }));
    check('library: all 3 settings toggles exist', Object.values(toggles).every(Boolean), JSON.stringify(toggles));
    const autosaveGone = await page.evaluate(() => !document.querySelector('#autosaveToggle'));
    check('library: no duplicate autosave toggle (local-saving switch owns persistence)', autosaveGone);
    const promotionCount = await page.evaluate(() => ({
      banners: document.querySelectorAll('#freeTierUpgradeBanner').length,
      staleCard: Boolean(document.querySelector('#plusCard, #plusState'))
    }));
    check('library: one free-tier promotion and no contradictory Plus sidebar card',
      promotionCount.banners === 1 && !promotionCount.staleCard, JSON.stringify(promotionCount));

    // License activation dialog follows the same keyboard and focus rules.
    await page.click('#openActivationBtn');
    const activationOpen = await page.evaluate(() => {
      const dialog = document.querySelector('#activationModal');
      return !dialog.classList.contains('hidden')
        && dialog.getAttribute('aria-describedby') === 'activationCopy'
        && document.activeElement?.id === 'activationInput';
    });
    check('library: activation dialog opens labelled with input focus', activationOpen);
    await page.focus('#activationCancel');
    await page.keyboard.press('Tab');
    const activationTrap = await page.evaluate(() => document.activeElement?.id === 'modalUpgradeCheckoutBtn');
    check('library: activation dialog traps Tab focus', activationTrap);
    await page.keyboard.press('Escape');
    const activationClosed = await page.evaluate(() =>
      document.querySelector('#activationModal').classList.contains('hidden')
      && document.activeElement?.id === 'openActivationBtn');
    check('library: Escape closes activation dialog and restores focus', activationClosed);

    // Opt in to stats sharing via the exact settings toggle, confirm it, then
    // restore the privacy-default off state.
    await page.evaluate(() => document.querySelector('#analyticsToggle').click());
    await new Promise((resolve) => setTimeout(resolve, 600));
    const analyticsAfter = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      return response?.settings?.analyticsConsent;
    });
    check('library: explicit stats opt-in persists to worker', analyticsAfter === true, String(analyticsAfter));
    await page.evaluate(() => document.querySelector('#analyticsToggle').click()); // restore default-off

    // Local saving defaults ON now.
    const localDefault = await page.evaluate(() => document.querySelector('#localSavingToggle').checked);
    check('library: local session saving defaults ON', localDefault === true, String(localDefault));

    // Regression (was "normalizeProfileOrigin is not defined"): with
    // remember-volumes ON, changing a volume must persist a site profile.
    await page.evaluate(() => document.querySelector('#rememberVolumesToggle').click());
    await new Promise((resolve) => setTimeout(resolve, 600));
    const volumeResult = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'SET_VOLUME', kind: 'dubbed', value: 0.8, origin: 'https://www.youtube.com' });
      return { ok: response?.ok, error: response?.error || null, plus: response?.plus };
    });
    check('library: SET_VOLUME with remember-volumes ON succeeds', volumeResult.ok === true, JSON.stringify(volumeResult.error || ''));
    const profileSaved = await page.evaluate(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'PLUS_GET_STATUS' });
      const profiles = status?.plus?.siteProfiles || [];
      return profiles.some((p) => String(p.origin || '').includes('youtube') && Number.isFinite(p.dubbedVolume));
    });
    check('library: site profile created from volume change', profileSaved === true);
    await page.screenshot({ path: path.join(visualDir, 'library-settings.png'), fullPage: true });

    check('library: no console/page errors', problems.length === 0, problems.join(' | '));
    await page.close();
  }

  // ---- Stats ----
  {
    const { page, problems } = await openPage('src/stats/stats.html');
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.waitForSelector('#totalDuration', { timeout: 5000 });
    const rendered = await page.evaluate(() => Boolean(document.querySelector('#totalDuration').textContent));
    check('stats: duration card renders', rendered);
    await page.screenshot({ path: path.join(visualDir, 'stats.png'), fullPage: true });
    check('stats: no console/page errors', problems.length === 0, problems.join(' | '));
    await page.close();
  }

  // ---- Sidepanel ----
  {
    const { page, problems } = await openPage('src/sidepanel/sidepanel.html');
    await page.setViewport({ width: 420, height: 850, deviceScaleFactor: 1 });
    await page.waitForSelector('#panelStatus', { timeout: 5000 });
    const status = await page.evaluate(() => document.querySelector('#panelStatus').textContent.trim());
    check('sidepanel: status pill renders', status.length > 0, status);
    const toolbarVisible = await page.evaluate(() => !document.querySelector('#plusToolbar').classList.contains('hidden'));
    check('sidepanel: Plus toolbar visible', toolbarVisible);
    await page.screenshot({ path: path.join(visualDir, 'sidepanel.png'), fullPage: true });
    check('sidepanel: no console/page errors', problems.length === 0, problems.join(' | '));
    await page.close();
  }

  // ---- Diagnostics ----
  {
    const { page, problems } = await openPage('src/diagnostics/diagnostics.html');
    await page.setViewport({ width: 520, height: 800, deviceScaleFactor: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({ path: path.join(visualDir, 'diagnostics.png'), fullPage: true });
    check('diagnostics: no console/page errors', problems.length === 0, problems.join(' | '));
    await page.close();
  }
} finally {
  await browser.close().catch(() => undefined);
}

if (failures.length) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nBROWSER SMOKE PASSED');

