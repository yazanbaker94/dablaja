// Full end-to-end suite: drives the REAL unpacked extension through every
// user-facing flow via real service-worker messages, real storage.session /
// storage.local, real IndexedDB, and the live audiofetcher.com backend.
// Single reused page (navigated between surfaces) — no target churn, which
// Edge's CDP stack handles badly.
// Usage: node scripts/e2e.mjs
import puppeteer from 'puppeteer-core';
import { existsSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(os.tmpdir(), 'dablaja-e2e-ext');
rmSync(stage, { recursive: true, force: true });
cpSync(root, stage, {
  recursive: true,
  filter: (src) => !/(^|\\|\/)(node_modules|\.git|dist|tests|server|landing|docs|promo|recordings|browser-test-output|design images|store-images|preview-1440|preview-plus-1440)(\\|\/|$)/.test(src)
    && !/\.(md|ps1|py|mjs|zip)$/.test(src)
});

const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('ok   -', name); }
  else { fail++; failures.push(name); console.log('FAIL -', name, '::', String(detail).slice(0, 160)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: false,
  args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`, '--no-first-run']
});
// An unresolved CDP promise alone does not keep Node alive. Keep a bounded
// watchdog handle so a prematurely disconnected browser can never look like a
// successful exit simply because the event loop became empty.
const overallTimeout = setTimeout(() => {
  console.error('E2E HARNESS TIMEOUT: browser flow did not reach final totals');
  process.exit(1);
}, 180_000);

// ---------- helpers ----------
const extId = async () => {
  const t = await browser.waitForTarget((x) => x.type() === 'service_worker' && x.url().includes('chrome-extension://'), { timeout: 20000 });
  return new URL(t.url()).host;
};
let idRef = null;
const problems = [];
const gotoExt = async (page, path_) => {
  await page.goto(`chrome-extension://${idRef}/${path_}`, { waitUntil: 'load' });
};
const msg = (page, payload) => page.evaluate((data) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ __timeout: true }), 20000);
  chrome.runtime.sendMessage(data, (resp) => { clearTimeout(t); resolve({ lastError: chrome.runtime.lastError?.message || null, resp }); });
}), payload);
const seedIdb = (page, records) => page.evaluate(async (list) => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('dablaja-plus', 1);
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    for (const r of list) store.put(r);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}, records);
const clearIdb = (page) => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('dablaja-plus', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
});
const resetStorage = (page) => page.evaluate(async () => {
  await chrome.storage.local.remove([
    'geminiApiKey', 'privacyConsentAt', 'privacyConsentVersion', 'originalVolume', 'dubbedVolume', 'autoDucking',
    'plusAutosave', 'plusRememberVolumes', 'plusSiteProfiles', 'plusLicense',
    'plusLocalLibraryConsent', 'plusLocalLibraryDecidedAt', 'anonymousUsageConsent', 'anonymousUsageDecisionAt', 'localUsageStats'
  ]);
  await chrome.storage.session.remove(['plusActiveDraft', 'plusUnsavedDrafts']);
});
function mkDraft(id, title, durMs, opts = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1, id, title,
    pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    siteOrigin: 'https://www.youtube.com',
    createdAt: now - durMs, updatedAt: now, startedAt: now - durMs,
    endedAt: opts.active ? null : now,
    durationMs: durMs,
    sourceSegments: [{ id: 's1', startMs: 0, endMs: 1500, text: 'Hello from the test', speaker: '', turnId: 0 }],
    targetSegments: [{ id: 't1', startMs: 0, endMs: 1500, text: 'مرحبا من الاختبار', speaker: '', turnId: 0 }],
    bookmarks: opts.bookmark ? [{ id: 'bmk_test1', atMs: 500, note: 'لحظة مهمة', createdAt: now, updatedAt: now }] : [],
    bookmarkTombstones: {}, notes: opts.notes || '', notesUpdatedAt: opts.notes ? now : 0,
    originalVolume: null, dubbedVolume: null
  };
}
const stripeCount = () => browser.targets().filter((t) => t.url().startsWith('https://checkout.stripe.com')).length;
const waitStripe = async (before, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stripeCount() > before) return browser.targets().filter((t) => t.url().startsWith('https://checkout.stripe.com')).pop().url();
    await sleep(400);
  }
  return null;
};
const sweepStripe = async () => {
  for (const p of await browser.pages()) {
    if (!p.url().startsWith('https://checkout.stripe.com')) continue;
    // Edge occasionally leaves Page.close unresolved after target churn. The
    // whole throwaway browser is closed in finally, so a bounded best-effort
    // close is sufficient here and must not stall the remaining suites.
    await Promise.race([p.close().catch(() => undefined), sleep(1500)]);
  }
  await sleep(400);
};

// Edge + puppeteer-core race: target churn can throw inside puppeteer's own
// EmulationManager (sync throw or unhandled rejection). Harness noise —
// filter the exact signature; anything else is fatal.
const isHarnessRace = (err) => {
  const text = String((err && (err.message || err.stack)) || err);
  return text.includes('#logger') || text.includes('EmulationManager') || text.includes('Target closed');
};
process.on('unhandledRejection', (err) => {
  if (isHarnessRace(err)) return;
  console.error('UNHANDLED REJECTION:', String((err && (err.message || err.stack)) || err));
});
process.on('uncaughtException', (err) => {
  if (isHarnessRace(err)) return;
  console.error('UNCAUGHT:', String((err && (err.message || err.stack)) || err));
  process.exit(1);
});

// ---------- boot ----------
const guard = await browser.newPage();
await guard.goto('about:blank');
idRef = await extId();
let page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
const noErrors = (suite) => check(`${suite}: no page errors`, problems.length === 0, problems.splice(0).join(' | '));
const freshPage = async (path_) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const p = await browser.newPage();
      p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
      await p.goto(`chrome-extension://${idRef}/${path_}`, { waitUntil: 'load' });
      return p;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000);
    }
  }
};

console.log(`extension: ${idRef}\n`);

try {
  // ================================================================
  // SUITE 1 — Key lifecycle (popup)
  // ================================================================
  console.log('--- SUITE 1: key lifecycle ---');
  await gotoExt(page, 'src/popup/popup.html');
  await page.waitForSelector('#startStop');
  await resetStorage(page); await sleep(400);

  let r = await msg(page, { type: 'GET_STATE' });
  check('S1: fresh install -> NO_KEY', r.resp.state.status === 'no_key', JSON.stringify(r.resp.state?.status));

  r = await msg(page, { type: 'SAVE_KEY', apiKey: 'short' });
  check('S1: short key rejected with Arabic error', r.resp.ok === false && /غير صالحة/.test(r.resp.error || ''), r.resp.error);

  r = await msg(page, { type: 'SAVE_KEY', apiKey: 'AIzaE2ETestKey000000000000000000000' });
  check('S1: valid-format key saves -> READY without consent-popup state', r.resp.ok === true && r.resp.state.status === 'ready' && r.resp.settings.hasKey === true && !('hasConsent' in r.resp.settings), JSON.stringify({ s: r.resp.state?.status, k: r.resp.settings?.hasKey }));

  r = await msg(page, { type: 'GET_API_KEY' });
  check('S1: GET_API_KEY returns stored key', r.resp.apiKey === 'AIzaE2ETestKey000000000000000000000');

  r = await msg(page, { type: 'START_SESSION' });
  check('S1: START with fake key -> live Gemini probe rejects', r.resp.ok === false && /غير صالح/.test(r.resp.error || ''), r.resp.error);

  r = await msg(page, { type: 'DELETE_KEY' });
  check('S1: delete key -> NO_KEY again', r.resp.ok === true && r.resp.state.status === 'no_key' && r.resp.settings.hasKey === false);

  await msg(page, { type: 'SAVE_KEY', apiKey: 'AIzaE2ETestKey000000000000000000000' });
  noErrors('S1');

  // ================================================================
  // SUITE 2 — Settings: volumes, ducking, language, analytics, feedback
  // ================================================================
  console.log('--- SUITE 2: settings & volumes ---');
  await gotoExt(page, 'src/library/library.html');
  await page.waitForSelector('#sessionGrid');

  r = await msg(page, { type: 'SET_AUTO_DUCKING', enabled: false });
  check('S2: SET_AUTO_DUCKING false persists', r.resp.ok === true);
  r = await msg(page, { type: 'GET_STATE' });
  check('S2: autoDucking reads back false', r.resp.settings.autoDucking === false);
  await msg(page, { type: 'SET_AUTO_DUCKING', enabled: true });

  r = await msg(page, { type: 'SET_VOLUME', kind: 'original', value: 0.3 });
  check('S2: global volume persists (rememberVolumes OFF)', r.resp.ok === true && (await msg(page, { type: 'GET_STATE' })).resp.settings.originalVolume === 0.3);

  r = await msg(page, { type: 'SET_UI_LANGUAGE', language: 'en' });
  check('S2: UI language -> en', r.resp.ok === true);
  r = await msg(page, { type: 'GET_STATE' });
  check('S2: uiLanguage reads back en', r.resp.settings.uiLanguage === 'en');
  await msg(page, { type: 'SET_UI_LANGUAGE', language: 'ar' });

  r = await msg(page, { type: 'SET_ANALYTICS_CONSENT', value: false });
  check('S2: analytics opt-out persists', (await msg(page, { type: 'GET_STATE' })).resp.settings.analyticsConsent === false);
  await msg(page, { type: 'SET_ANALYTICS_CONSENT', value: true });

  r = await msg(page, { type: 'GET_FEEDBACK_URL', source: 'e2e' });
  const fu = new URL(r.resp.url);
  check('S2: feedback URL carries source but no persistent install id', fu.hostname === 'audiofetcher.com' && !fu.searchParams.has('install_id') && fu.searchParams.get('source') === 'e2e', r.resp.url);

  noErrors('S2');

  // ================================================================
  // SUITE 3 — Site profiles & free cap (rememberVolumes ON)
  // ================================================================
  console.log('--- SUITE 3: site profiles & caps ---');
  await msg(page, { type: 'PLUS_SET_REMEMBER_VOLUMES', value: true });
  r = await msg(page, { type: 'SET_VOLUME', kind: 'dubbed', value: 0.9, origin: 'https://www.youtube.com' });
  check('S3: first profile saves', r.resp.ok === true && (r.resp.plus?.siteProfiles || []).some((x) => String(x.origin).includes('youtube')), JSON.stringify(r.resp.plus?.siteProfiles));

  r = await msg(page, { type: 'SET_VOLUME', kind: 'dubbed', value: 0.7, origin: 'https://vimeo.com' });
  check('S3: free 2nd origin -> limitReached + upgradeRequired', r.resp.ok === true && r.resp.limitReached === true && r.resp.upgradeRequired === true, JSON.stringify({ lr: r.resp.limitReached, ur: r.resp.upgradeRequired }));

  r = await msg(page, { type: 'PLUS_UPDATE_SITE_PROFILE', origin: 'https://www.youtube.com', originalVolume: 0.15, dubbedVolume: null });
  check('S3: profile edit keeps other value (null preserves)', r.resp.ok === true && (r.resp.plus?.siteProfiles?.[0]?.originalVolume === 0.15), JSON.stringify(r.resp.plus?.siteProfiles));

  r = await msg(page, { type: 'PLUS_DELETE_SITE_PROFILE', origin: 'https://www.youtube.com' });
  check('S3: profile delete works', r.resp.ok === true && (r.resp.plus?.siteProfiles || []).length === 0);
  await msg(page, { type: 'PLUS_SET_REMEMBER_VOLUMES', value: false });

  noErrors('S3');

  // ================================================================
  // SUITE 4 — Crashed-session recovery across SW suspension
  // ================================================================
  console.log('--- SUITE 4: crashed session recovery ---');
  await clearIdb(page);
  const active = mkDraft('plussession_e2ea1', 'E2E Active - YouTube', 40000, { active: true });
  const unsaved = [mkDraft('plussession_e2eu1', 'E2E Unsaved - YouTube', 20000)];
  await page.evaluate(async ({ a, u }) => {
    await chrome.storage.session.set({ plusActiveDraft: a });
    await chrome.storage.session.set({ plusUnsavedDrafts: u });
  }, { a: active, u: unsaved });
  console.log('waiting 35s for service-worker suspension...');
  await page.close(); // closing the view lets the idle worker suspend
  await sleep(35000);
  page = await freshPage('src/library/library.html'); // wake: startup restore + self-heal
  await page.waitForSelector('#sessionGrid');
  await sleep(1500);

  const recState = await page.evaluate(() => ({
    draftVisible: !document.querySelector('#draftSection').classList.contains('hidden'),
    drafts: document.querySelectorAll('#draftBody .draft-info').length,
    cards: document.querySelectorAll('#sessionGrid .session-card').length
  }));
  check('S4: crashed unsaved sessions remain visible drafts, not silent permanent saves', recState.draftVisible && recState.drafts === 2 && recState.cards === 0, JSON.stringify(recState));

  r = await msg(page, { type: 'STOP_SESSION' });
  check('S4: STOP_SESSION idle -> ok, stopped state', r.resp.ok === true && ['stopped', 'ready', 'no_key'].includes(r.resp.state?.status), JSON.stringify(r.resp.state?.status));

  const recovered = await page.evaluate(async () => (await chrome.storage.session.get('plusUnsavedDrafts')).plusUnsavedDrafts || []);
  check('S4: recovered draft keeps transcript segments + title', recovered.some((x) => x.id === 'plussession_e2ea1' && x.targetSegments?.length === 1 && /E2E Active/.test(x.title)), JSON.stringify(recovered.map((x) => x.id)));
  noErrors('S4');

  // ================================================================
  // SUITE 5 — Library data ops: locks, notes, bookmark delete, search
  // ================================================================
  console.log('--- SUITE 5: library data ops ---');
  await clearIdb(page);
  const older = mkDraft('plussession_e2eb1', 'E2E Active - YouTube', 40000);
  const newer = mkDraft('plussession_e2en1', 'E2E Newer - YouTube', 20000, { bookmark: true, notes: 'ملاحظات أصلية' });
  await seedIdb(page, [older, newer]);
  await page.evaluate(() => window.reloadAll());
  await sleep(600);

  let ui = await page.evaluate(() => ({
    cards: document.querySelectorAll('#sessionGrid .session-card').length,
    hostageLocked: document.querySelectorAll('#sessionGrid .session-card.is-pro-locked').length
  }));
  check('S5: existing local records remain readable while Plus is locked', ui.cards === 2 && ui.hostageLocked === 0, JSON.stringify(ui));

  r = await msg(page, { type: 'PLUS_UPDATE_NOTES', sessionId: 'plussession_e2eb1', notes: 'ملاحظة E2E محفوظة' });
  check('S5: PLUS_UPDATE_NOTES persists', r.resp.ok === true);

  r = await msg(page, { type: 'PLUS_DELETE_BOOKMARK', sessionId: 'plussession_e2en1', bookmarkId: 'bmk_test1' });
  check('S5: PLUS_DELETE_BOOKMARK works while locked (data not held hostage)', r.resp.ok === true, r.resp.error);

  await page.type('#searchInput', 'E2E Active');
  await sleep(400);
  const visible = await page.evaluate(() => document.querySelectorAll('#sessionGrid .session-card').length);
  check('S5: search narrows grid to matching card', visible === 1, String(visible));
  await page.evaluate(() => { const i = document.querySelector('#searchInput'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  noErrors('S5');

  // ================================================================
  // SUITE 6 — Export / import gate + delete-all
  // ================================================================
  console.log('--- SUITE 6: backup export/import ---');
  const dlDir = path.join(os.tmpdir(), 'dablaja-e2e-dl');
  mkdirSync(dlDir, { recursive: true });
  try { readdirSync(dlDir).forEach((f) => unlinkSync(path.join(dlDir, f))); } catch {}
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  await page.evaluate(() => document.querySelector('[data-nav="backup"]').click());
  await page.evaluate(() => document.querySelector('#exportBackup').click());
  let exported = null;
  for (let i = 0; i < 20 && !exported; i++) {
    await sleep(300);
    try { exported = readdirSync(dlDir).find((f) => f.endsWith('.json')); } catch {}
  }
  check('S6: export downloads a JSON backup', Boolean(exported), 'no file');
  const backupText = exported ? readFileSync(path.join(dlDir, exported), 'utf8') : '{}';
  const parsed = JSON.parse(backupText);
  check('S6: backup contains both sessions with transcripts', (parsed.sessions || []).length >= 2 && (parsed.sessions || []).some((s) => (s.targetSegments || []).length > 0), `sessions=${(parsed.sessions || []).length}`);

  await page.evaluate(() => document.querySelector('#deleteAll').click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('#modalConfirm').click());
  await sleep(600);
  const empty = await page.evaluate(() => document.querySelectorAll('#sessionGrid .session-card').length);
  check('S6: delete-all empties the grid', empty === 0, String(empty));

  const fileInput = await page.$('#importFile');
  await fileInput.uploadFile(path.join(dlDir, exported));
  await sleep(1200);
  const importStatus = await page.evaluate(() => document.querySelector('#importStatus')?.textContent || '');
  check('S6: import on free -> gated with clear Arabic error', /Plus غير مفعّل|فشل الاستيراد/.test(importStatus), importStatus.slice(0, 80));
  noErrors('S6');
  await cdp.detach().catch(() => undefined);

  // ================================================================
  // SUITE 7 — Licensing surface: activation, recovery, checkout
  // ================================================================
  console.log('--- SUITE 7: licensing ---');
  r = await msg(page, { type: 'PLUS_ACTIVATE_LICENSE', token: 'dpl1.garbage.sig' });
  check('S7: forged token rejected', r.resp.ok === false, JSON.stringify(r.resp.error));

  if (process.env.DABLAJA_E2E_LIVE_SERVER === '1') {
    r = await msg(page, { type: 'PLUS_RECOVER_LICENSE', code: 'DABLAJA-ZZZZZZZZZZZZZZZZZZZZ' });
    check('S7: unknown recovery code -> server rejection surfaced', r.resp.ok === false, r.resp.error);
  } else {
    console.log('skip - S7 live recovery probe (set DABLAJA_E2E_LIVE_SERVER=1 explicitly)');
  }

  r = await msg(page, { type: 'PLUS_GET_STATUS' });
  check('S7: entitlement locked for free install', r.resp.plus?.entitlement?.plusEnabled === false, JSON.stringify(r.resp.plus?.entitlement));

  if (process.env.DABLAJA_E2E_LIVE_CHECKOUT === '1') {
    // Reserve an unmistakable installation id so an abandoned live test
    // Checkout can be audited/expired without touching a real installation.
    await page.evaluate(() => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const credential = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return chrome.storage.local.set({
        installId: `e2e-checkout-${Date.now().toString(36)}`,
        plusInstallCredential: credential
      });
    });
    const before = stripeCount();
    r = await msg(page, { type: 'PLUS_START_CHECKOUT' });
    const stripeUrl = await waitStripe(before);
    check('S7: explicitly enabled live-checkout probe opens Stripe', r.resp.ok === true && Boolean(stripeUrl && stripeUrl.includes('checkout.stripe.com/c/pay/cs_live')), stripeUrl?.slice(0, 60) || 'no tab');
    await sweepStripe().catch(() => undefined);
  } else {
    console.log('skip - S7 live checkout (set DABLAJA_E2E_LIVE_CHECKOUT=1 explicitly)');
  }
  noErrors('S7');

  // ================================================================
  // SUITE 8 — Stats page + usage stats lifecycle
  // ================================================================
  console.log('--- SUITE 8: stats ---');
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await page.evaluate((dayKey) => chrome.storage.local.set({
    localUsageStats: {
      totalDurationMs: 1500000, sessionCount: 5, activeDays: [dayKey],
      activeHours: new Array(24).fill(0), sentAudioMs: 1200000,
      latencyTotalMs: 5000, latencySamples: 10, reconnects: 1,
      normalStops: 4, errorStops: 1, lastSessionAt: new Date().toISOString(),
      firstSessionAt: new Date().toISOString(), lastSessionDurationMs: 300000,
      lastSessionSite: 'youtube.com', lastSessionLatencyMs: 500,
      longestSessionMs: 600000, dailyMinutes: { [dayKey]: 25 }, dailySessions: { [dayKey]: 5 },
      sites: { 'youtube.com': { durationMs: 1500000, sessionCount: 5, lastAt: new Date().toISOString(), days: { [dayKey]: { durationMs: 1500000, sessionCount: 5 } } } }
    }
  }), day);
  // The worker caches usageStats after startup. Reload the isolated extension
  // so this storage seed is read through the same initialization path used
  // after a real browser restart.
  await page.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await sleep(1500);
  page = await freshPage('src/stats/stats.html');
  await page.waitForSelector('#totalDuration');
  await sleep(500);
  const rendered = await page.evaluate(() => ({
    total: document.querySelector('#totalDuration').textContent,
    sessions: document.querySelector('#sessionCount').textContent,
    sites: document.querySelectorAll('#siteList .site-row').length
  }));
  check('S8: stats render seeded minutes', /[0-9٠-٩]/.test(rendered.total) && rendered.total !== '—', JSON.stringify(rendered));
  check('S8: session count renders', /[0-9٠-٩]/.test(rendered.sessions), rendered.sessions);
  check('S8: site rows render', rendered.sites >= 1, String(rendered.sites));

  await page.evaluate(() => document.querySelector('button[data-range="month"]')?.click());
  await sleep(300);
  const still = await page.evaluate(() => document.querySelector('#totalDuration').textContent.length > 0);
  check('S8: month range switch renders', still);

  await page.evaluate(() => document.querySelector('#clearStats').click());
  await sleep(500);
  const cleared = await page.evaluate(() => document.querySelector('#totalDuration').textContent);
  check('S8: clear stats zeroes the view', /٠|0/.test(cleared), cleared);
  noErrors('S8');

  // ================================================================
  // SUITE 9 — Sidepanel: language round-trip, status, plus toolbar
  // ================================================================
  console.log('--- SUITE 9: sidepanel ---');
  await gotoExt(page, 'src/sidepanel/sidepanel.html');
  await page.waitForSelector('#panelStatus');
  let title = await page.evaluate(() => document.querySelector('#panelTitle').textContent);
  check('S9: sidepanel renders Arabic title', /الترجمة الثنائية/.test(title), title);

  await page.evaluate(() => document.querySelector('#languageToggle').click());
  await sleep(400);
  title = await page.evaluate(() => document.querySelector('#panelTitle').textContent);
  check('S9: language toggle -> English title', /Bilingual captions/.test(title), title);

  const saveDisabled = await page.evaluate(() => document.querySelector('#plusSave').disabled);
  check('S9: save disabled with no active draft', saveDisabled === true);

  await page.evaluate(() => document.querySelector('#languageToggle').click());
  await sleep(300);
  noErrors('S9');

  // ================================================================
  // SUITE 10 — Live server: usage + errors dedupe
  // ================================================================
  console.log('--- SUITE 10: live server ingestion ---');
  if (process.env.DABLAJA_E2E_LIVE_SERVER === '1') {
    const origin = `chrome-extension://${idRef}`;
    const server = await page.evaluate(async (originHdr) => {
    const post = async (path_, body) => {
      const res = await fetch(`https://audiofetcher.com/dablaja${path_}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': originHdr }, body: JSON.stringify(body)
      });
      return { code: res.status, body: await res.json().catch(() => null) };
    };
    const usageEvent = 'e2eusage' + Date.now().toString(36);
    const u1 = await post('/api/usage', { event_id: usageEvent, platform: 'youtube', dubbed_ms: 60000 });
    const u2 = await post('/api/usage', { event_id: usageEvent, platform: 'youtube', dubbed_ms: 60000 });
    // Production requires a clean event id of at least 16 characters. Use the
    // same UUID-shaped value emitted by reportRemoteError() so this opt-in
    // live probe exercises ingestion instead of only exercising validation.
    const errorEvent = 'e2e-error-' + crypto.randomUUID();
    const e1 = await post('/api/errors', { event_id: errorEvent, error_code: 'network_error', status: 'error', site_host: 'youtube', extension_version: '1.0.0' });
    const e2 = await post('/api/errors', { event_id: errorEvent, error_code: 'network_error', status: 'error', site_host: 'youtube', extension_version: '1.0.0' });
    return { u1, u2, e1, e2 };
    }, origin);
    check('S10: usage accepted then deduped', server.u1.body?.status === 'ok' && server.u2.body?.status === 'duplicate', JSON.stringify({ u1: server.u1.body, u2: server.u2.body }));
    check('S10: errors accepted then deduped by one-time event id without install identity', server.e1.body?.status === 'ok' && server.e2.body?.status === 'duplicate', JSON.stringify({ e1: server.e1.body, e2: server.e2.body }));
  } else {
    console.log('skip - S10 live ingestion (set DABLAJA_E2E_LIVE_SERVER=1 explicitly)');
  }

  // ================================================================
  // SUITE 11 — Local-saving setting persistence
  // ================================================================
  console.log('--- SUITE 11: local saving ---');
  await gotoExt(page, 'src/library/library.html');
  await page.waitForSelector('#sessionGrid');
  r = await msg(page, { type: 'PLUS_SET_LOCAL_SAVING', value: false });
  check('S11: local saving off persists', (r.resp.plus?.localSavingEnabled) === false);
  check('S11: local-saving choice survives a fresh status read', (await msg(page, { type: 'PLUS_GET_STATUS' })).resp.plus?.localSavingEnabled === false);
  r = await msg(page, { type: 'PLUS_SET_LOCAL_SAVING', value: true });
  check('S11: local saving back ON persists', (await msg(page, { type: 'PLUS_GET_STATUS' })).resp.plus?.localSavingEnabled === true);
  noErrors('S11');
} catch (error) {
  fail++;
  failures.push('E2E harness completed all suites');
  console.error('E2E HARNESS ERROR:', String((error && (error.message || error.stack)) || error));
} finally {
  await Promise.race([browser.close().catch(() => undefined), sleep(5000)]);
  clearTimeout(overallTimeout);
  rmSync(stage, { recursive: true, force: true });
}

console.log(`\nE2E TOTALS: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAILURES: ' + failures.join(', ')); process.exit(1); }
console.log('E2E SUITE PASSED');
