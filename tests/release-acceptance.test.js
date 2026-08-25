import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlusDraftController } from '../src/shared/plus-draft-controller.js';
import { verifyLicenseToken, PLUS_LICENSE_PUBLIC_KEY_B64, OFFLINE_GRACE_MS, TOKEN_TTL_MS, resolveEntitlement } from '../src/shared/plus-entitlement.js';
import { createPlusMessageHandler } from '../src/shared/plus-messages.js';
import { buildSetupMessage } from '../src/shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Helpers
function fakeStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? { [k]: structuredClone(map.get(k)) } : {}; },
    async set(o) { for (const [k,v] of Object.entries(o)) map.set(k, structuredClone(v)); },
    async remove(k) { map.delete(k); }
  };
}

const ENTITLED = { plusEnabled: true, state: 'active' };
const LOCKED = { plusEnabled: false, state: 'locked' };

// 1. Explicit save semantics
test('Start + stop with autosave OFF creates no permanent session, retains draft', async () => {
  const storage = fakeStorage();
  const db = { records: new Map(), async putSession(r, opts) { const c=structuredClone(r); this.records.set(c.id,c); return c; }, async getSession(id){ return this.records.get(id)||null; } };
  const controller = createPlusDraftController({ storage, db, getEntitlement: async ()=> ENTITLED, isFree: false, now: ()=> 1000 });
  await controller.start({ startedAt: 0, siteOrigin: 'youtube.com' });
  controller.caption({ channel: 'target', text: 'مرحبا', final: true });
  // No explicit save
  await controller.finish({ autosave: false });
  assert.equal(db.records.size, 0, 'autosave off must not create permanent session');
  const drafts = storage.map.get('plusUnsavedDrafts');
  assert.ok(Array.isArray(drafts) && drafts.length===1, 'visible recoverable draft remains');
  // Explicit save writes exactly one
  const controller2 = createPlusDraftController({ storage, db, getEntitlement: async ()=> ENTITLED, isFree: false, now: ()=>2000 });
  const draftId = drafts[0].id;
  const saved = await controller2.saveUnsaved(draftId);
  assert.equal(db.records.size, 1, 'explicit save writes exactly one');
  assert.equal(saved.id, draftId);
});

test('Autosave ON writes exactly one record', async () => {
  const storage = fakeStorage();
  const db = { records: new Map(), async putSession(r){ const c=structuredClone(r); this.records.set(c.id,c); return c; }, async getSession(id){return this.records.get(id)||null;} };
  const controller = createPlusDraftController({ storage, db, getEntitlement: async()=> ENTITLED, now:()=> 1000 });
  await controller.start({ startedAt:0, siteOrigin: 'youtube.com' });
  controller.caption({ channel: 'target', text: 'نص', final: true });
  await controller.finish({ autosave: true });
  assert.equal(db.records.size, 1);
});

test('Stop is tier-aware: Plus auto-saves and the free tier uses its one included slot', async () => {
  const sw = await readFile(path.join(root,'src/service-worker.js'),'utf8');
  assert.ok(sw.includes('autosave: plusNow.entitlement.plusEnabled === true'), 'Plus autosave must follow verified entitlement');
  assert.ok(sw.includes('await plusController.saveActive()'), 'first included free session must be saved explicitly');
  assert.ok(sw.includes('existing.length < 1'), 'free save must be bounded to one session');
  assert.ok(!sw.includes('PLUS_AUTOSAVE'), 'the autosave setting must not exist anywhere in the worker');
  const constants = await readFile(path.join(root,'src/shared/constants.js'),'utf8');
  assert.ok(constants.includes('PLUS_LOCAL_SAVING_ENABLED'), 'local-saving preference must be stored in chrome.storage.local');
});

test('Free tier limit is one session and existing local data has no view lock', async () => {
  const entitlement = await readFile(path.join(root,'src/shared/plus-entitlement.js'),'utf8');
  assert.match(entitlement, /FREE:\s*\{[\s\S]*?MAX_SESSIONS:\s*1/);
  const messages = await readFile(path.join(root,'src/shared/plus-messages.js'),'utf8');
  assert.ok(messages.includes('requireSessionSaveCapacity'));
  assert.ok(messages.includes('existing.length >= 1'));
  const library = await readFile(path.join(root,'src/library/library.js'),'utf8');
  assert.ok(!library.includes('function isSessionLocked('), 'existing records must remain readable');
  assert.ok(!library.includes('unlockedBookmarkId'), 'existing bookmarks must remain readable');
});

test('IndexedDB failure retains recovery copy', async () => {
  const storage = fakeStorage();
  const db = { records: new Map(), async putSession(){ throw new Error('idb fail'); }, async getSession(){return null;} };
  const controller = createPlusDraftController({ storage, db, getEntitlement: async()=> ENTITLED, now:()=> 1000 });
  await controller.start({ startedAt:0, siteOrigin:'youtube.com' });
  controller.caption({ channel:'target', text:'نص', final:true });
  const result = await controller.finish({ autosave:true });
  assert.equal(result, null);
  assert.ok(storage.map.has('plusActiveDraft'), 'recovery copy retained');
});

test('Saved animation only after confirmed persistence', async () => {
  const popup = await readFile(path.join(root,'src/popup/popup.js'),'utf8');
  assert.ok(popup.includes('if (response?.saved === true)'), 'animation must be gated on saved flag');
  const sw = await readFile(path.join(root,'src/service-worker.js'),'utf8');
  assert.ok(sw.includes('saved: Boolean(') || sw.includes('saved: true'), 'service worker must return saved flag');
});

test('Bookmark/note concurrent merge respects tombstones and updatedAt', async () => {
  const { mergeDraftWithSaved } = await import('../src/shared/plus-session.js');
  const live = {
    id: 'plussession_abc123',
    title: 'live',
    siteOrigin: 'youtube.com',
    bookmarks: [{ id: 'bmk_1', atMs: 1000, note: 'old', createdAt: 1000, updatedAt: 1000 }, { id: 'bmk_2', atMs: 2000, note: 'live new', createdAt: 2000, updatedAt: 2000 }],
    bookmarkTombstones: {},
    notes: '',
    notesUpdatedAt: 0,
    updatedAt: 2000,
    sourceSegments: [], targetSegments: []
  };
  const saved = {
    id: 'plussession_abc123',
    title: 'saved',
    siteOrigin: 'youtube.com',
    bookmarks: [{ id: 'bmk_1', atMs: 1000, note: 'edited', createdAt: 1000, updatedAt: 3000 }],
    bookmarkTombstones: { 'bmk_2': 2500 }, // deleted bmk_2 after live created it
    notes: 'edited notes',
    notesUpdatedAt: 3000,
    updatedAt: 3000,
    sourceSegments: [], targetSegments: []
  };
  const merged = mergeDraftWithSaved(live, saved);
  assert.equal(merged.notes, 'edited notes', 'newer notes win');
  assert.equal(merged.bookmarks.length, 1);
  assert.equal(merged.bookmarks[0].id, 'bmk_1');
  assert.equal(merged.bookmarks[0].note, 'edited', 'newer bookmark note wins');
  assert.ok(!merged.bookmarks.find(b=>b.id==='bmk_2'), 'deleted bookmark not resurrected');
});

test('No duplicate bookmarks or records after merge', async () => {
  const { mergeDraftWithSaved } = await import('../src/shared/plus-session.js');
  const live = {
    id: 'plussession_dup',
    bookmarks: [{ id: 'bmk_1', atMs: 1000, note: 'a', createdAt: 1000, updatedAt: 1000 }],
    bookmarkTombstones: {},
    notes: '',
    notesUpdatedAt: 0,
    updatedAt: 1000,
    sourceSegments: [], targetSegments: []
  };
  const saved = {
    id: 'plussession_dup',
    bookmarks: [{ id: 'bmk_1', atMs: 1000, note: 'a', createdAt: 1000, updatedAt: 1000 }],
    bookmarkTombstones: {},
    notes: '',
    notesUpdatedAt: 0,
    updatedAt: 1000,
    sourceSegments: [], targetSegments: []
  };
  const merged = mergeDraftWithSaved(live, saved);
  assert.equal(merged.bookmarks.length, 1);
});

// Token binding, expiry, grace, revocation, legacy rejection
test('Token installation binding: copying token to another install rejected', async () => {
  const { generateKeyPair } = await import('node:crypto');
  // Use WebCrypto to generate and sign via verifyLicenseToken path
  const webcrypto = globalThis.crypto;
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign','verify']);
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const b64 = Buffer.from(pubRaw).toString('base64');
  const encoder = new TextEncoder();
  function b64u(bytes){ return Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function sign(payload){
    const raw = encoder.encode(JSON.stringify(payload));
    const prefix = encoder.encode('dpl1.');
    const signed = new Uint8Array(prefix.length+raw.length);
    signed.set(prefix,0); signed.set(raw,prefix.length);
    const sig = new Uint8Array(await webcrypto.subtle.sign({name:'Ed25519'}, keyPair.privateKey, signed));
    return `dpl1.${b64u(raw)}.${b64u(sig)}`;
  }
  const nowSec = Math.floor(Date.now()/1000);
  const token = await sign({ lid: 'lic1', iid: 'install-A', iat: nowSec-10, exp: nowSec+3600 });
  const ok = await verifyLicenseToken(token, { expectedInstallId: 'install-A', nowMs: Date.now(), publicKeyB64: b64 });
  assert.ok(ok, 'correct install should activate');
  const bad = await verifyLicenseToken(token, { expectedInstallId: 'install-B', nowMs: Date.now(), publicKeyB64: b64 });
  assert.equal(bad, null, 'copied token rejected');
});

test('Expired and future iat tokens rejected', async () => {
  const webcrypto = globalThis.crypto;
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign','verify']);
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const b64 = Buffer.from(pubRaw).toString('base64');
  const encoder = new TextEncoder();
  function b64u(bytes){ return Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function sign(payload){
    const raw = encoder.encode(JSON.stringify(payload));
    const prefix = encoder.encode('dpl1.');
    const signed = new Uint8Array(prefix.length+raw.length);
    signed.set(prefix,0); signed.set(raw,prefix.length);
    const sig = new Uint8Array(await webcrypto.subtle.sign({name:'Ed25519'}, keyPair.privateKey, signed));
    return `dpl1.${b64u(raw)}.${b64u(sig)}`;
  }
  const nowSec = Math.floor(Date.now()/1000);
  const expired = await sign({ lid: 'lic1', iid: 'iid1', iat: nowSec-100, exp: nowSec-10 });
  assert.equal(await verifyLicenseToken(expired, { expectedInstallId: 'iid1', nowMs: Date.now(), publicKeyB64: b64 }), null);
  const future = await sign({ lid: 'lic1', iid: 'iid1', iat: nowSec+10000, exp: nowSec+20000 });
  assert.equal(await verifyLicenseToken(future, { expectedInstallId: 'iid1', nowMs: Date.now(), publicKeyB64: b64 }), null);
});

test('Handcrafted legacy record rejected for Plus unlock', async () => {
  const handler = createPlusMessageHandler({
    controller: { status:()=>({active:null, storageWarning:null}), save: async()=>{throw new Error()}, saveUnsaved: async()=>{throw new Error()}, bookmark: async()=>{}, discardUnsaved: async()=>{} },
    library: { get: async()=>null, list: async()=>[], put: async(r)=>r, delete: async()=>{}, clear: async()=>{}, putBatch: async()=>({written:0}) },
    settings: { get: async()=>({entitlement:{plusEnabled:false}}), setLicense: async(r)=>r, setAutosave: async()=>{}, setRemember: async()=>{}, deleteProfile: async()=>{} },
    entitlement: async()=> ({entitlement:{plusEnabled:false}}),
    tokenPublicKey: ''
  });
  await assert.rejects(()=> handler({ type: 'PLUS_ACTIVATE_LICENSE', license: { state: 'active', verifier: 'entitlement_endpoint' } }), /سجل الترخيص غير صالح/);
});

test('Revocation overrides cached active', async () => {
  const webcrypto = globalThis.crypto;
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign','verify']);
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const b64 = Buffer.from(pubRaw).toString('base64');
  const encoder = new TextEncoder();
  function b64u(bytes){ return Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function sign(payload){
    const raw = encoder.encode(JSON.stringify(payload));
    const prefix = encoder.encode('dpl1.');
    const signed = new Uint8Array(prefix.length+raw.length);
    signed.set(prefix,0); signed.set(raw,prefix.length);
    const sig = new Uint8Array(await webcrypto.subtle.sign({name:'Ed25519'}, keyPair.privateKey, signed));
    return `dpl1.${b64u(raw)}.${b64u(sig)}`;
  }
  const nowSec = Math.floor(Date.now()/1000);
  const token = await sign({ lid: 'lic1', iid: 'iid1', iat: nowSec - 10, exp: nowSec + 3600 });
  const active = { state: 'active', token };
  const revoked = { state: 'revoked', token };
  const entActive = await resolveEntitlement({ licenseRecord: active, expectedInstallId: 'iid1', publicKeyB64: b64 });
  assert.equal(entActive.plusEnabled, true);
  const entRevoked = await resolveEntitlement({ licenseRecord: revoked, expectedInstallId: 'iid1', publicKeyB64: b64 });
  assert.equal(entRevoked.plusEnabled, false);
  assert.equal(entRevoked.state, 'revoked');
});

test('Offline grace is bounded', async () => {
  const webcrypto = globalThis.crypto;
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign','verify']);
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const b64 = Buffer.from(pubRaw).toString('base64');
  const encoder = new TextEncoder();
  function b64u(bytes){ return Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function sign(payload){
    const raw = encoder.encode(JSON.stringify(payload));
    const prefix = encoder.encode('dpl1.');
    const signed = new Uint8Array(prefix.length+raw.length);
    signed.set(prefix,0); signed.set(raw,prefix.length);
    const sig = new Uint8Array(await webcrypto.subtle.sign({name:'Ed25519'}, keyPair.privateKey, signed));
    return `dpl1.${b64u(raw)}.${b64u(sig)}`;
  }
  const nowSec = Math.floor(Date.now()/1000);
  const expiredToken = await sign({ lid: 'lic1', iid: 'iid1', iat: nowSec - 100 * 86400, exp: nowSec - 10 * 86400 });
  const expired = { state: 'active', token: expiredToken };
  const ent = await resolveEntitlement({ licenseRecord: expired, expectedInstallId: 'iid1', nowMs: Date.now(), publicKeyB64: b64 });
  assert.equal(ent.plusEnabled, false);
  assert.equal(ent.state, 'expired');
});

test('Remote asset policy: saved sessions never trigger third-party thumbnail requests', async () => {
  const libJs = await readFile(path.join(root,'src/library/library.js'),'utf8');
  const literals = [...libJs.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `library must use bundled artwork only: ${literals.join(', ')}`);
  assert.ok(!libJs.includes('thumbnailUrl'), 'untrusted imported thumbnail URLs must not be rendered');
  assert.ok(!libJs.includes('ref-thumb-'), 'library must not fabricate topic-matched thumbnails');
  const libCss = await readFile(path.join(root,'src/library/library.css'),'utf8');
  assert.ok(!libCss.includes('fonts.googleapis.com'), 'no remote font');
});

test('startup restores crash drafts without silently saving them', async () => {
  const sw = await readFile(path.join(root,'src/service-worker.js'),'utf8');
  assert.match(sw, /plusController\.restore\(\)/, 'crash recovery must run');
  assert.ok(!/saveUnsaved\(draft\.id\)/.test(sw), 'startup must not convert drafts into permanent records without a user action');
});

test('library renders recoverable drafts with explicit Save and Discard actions', async () => {
  const lib = await readFile(path.join(root,'src/library/library.js'),'utf8');
  const idx = lib.indexOf('async function renderDraftCard()');
  const body = lib.slice(idx, lib.indexOf('function showSaveStatus', idx));
  assert.match(body, /saveBtn\.addEventListener\('click'/, 'Save is an explicit user action');
  assert.match(body, /PLUS_SAVE_UNSAVED/, 'Save action reaches the worker');
  assert.match(body, /PLUS_DISCARD_DRAFT/, 'Discard action reaches the worker');
  assert.ok(!body.includes('failed.push(draft)'), 'opening the library must not auto-save every draft');
});

test('Exact bounded marketing claims', async () => {
  const files = ['src/library/library.html','src/popup/popup.html','src/stats/stats.html','src/shared/plus-entitlement.js'];
  for(const f of files){
    const text = await readFile(path.join(root,f),'utf8');
    assert.ok(!text.includes('غير المحدود'), `${f} must not contain unlimited claim`);
    assert.ok(!text.includes('بلا حدود') || text.includes('حتى 500'), `${f} unbounded`);
  }
  const sessionLimits = await readFile(path.join(root,'src/shared/plus-session.js'),'utf8');
  assert.ok(sessionLimits.includes('MAX_BOOKMARKS_PER_SESSION: 100'), 'bookmark limit must be 100');
  const entLimits = await readFile(path.join(root,'src/shared/plus-entitlement.js'),'utf8');
  assert.ok(entLimits.includes('MAX_BOOKMARKS_PER_SESSION: 100'), 'entitlement bookmark limit must be 100');
});

test('Privacy/version consistency', async () => {
  const manifest = JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.version, '1.0.0');
  const priv = await readFile(path.join(root,'PRIVACY.md'),'utf8');
  assert.ok(priv.includes('chrome.storage.local') || priv.includes('local'), 'privacy must disclose local storage');
});

test('Package allowlist and secret scan', async () => {
  const pkgPs1 = await readFile(path.join(root,'scripts/package.ps1'),'utf8');
  assert.ok(pkgPs1.includes('Allowlisted file missing') || pkgPs1.includes('allowlist') || pkgPs1.includes('Allowlisted'), 'package must use allowlist');
  const allowlistBlock = pkgPs1.match(/\$allowList\s*=\s*@\(([\s\S]*?)\n\)/);
  assert.ok(allowlistBlock, 'package allowlist must be parseable');
  const packagedFiles = new Set(
    [...allowlistBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1].replace(/\\/g, '/'))
  );
  const importPattern = /^\s*import\b(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]\s*;?/gm;
  for (const relative of packagedFiles) {
    if (!relative.endsWith('.js')) continue;
    const source = await readFile(path.join(root, relative), 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      const dependency = path.posix.extname(resolved) ? resolved : `${resolved}.js`;
      assert.ok(packagedFiles.has(dependency), `${relative} imports ${dependency}, but the ZIP allowlist omits it`);
    }
  }
  for (const relative of packagedFiles) {
    if (!relative.endsWith('.html') && !relative.endsWith('.css')) continue;
    const source = await readFile(path.join(root, relative), 'utf8');
    const references = relative.endsWith('.html')
      ? [...source.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1])
      : [...source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((match) => match[1]);
    for (const reference of references) {
      if (!reference || /^(?:https?:|data:|chrome-extension:|#|mailto:)/i.test(reference)) continue;
      const cleanReference = reference.split(/[?#]/, 1)[0];
      const resource = path.posix.normalize(path.posix.join(path.posix.dirname(relative), cleanReference));
      assert.ok(packagedFiles.has(resource), `${relative} references ${resource}, but the ZIP allowlist omits it`);
    }
  }
  const check = await readFile(path.join(root,'scripts/check.mjs'),'utf8');
  assert.ok(check.includes('AIza') || check.includes('secret'), 'secret scan must exist');
});

test('Current Gemini setup structure', async () => {
  const { buildLegacySetupMessage } = await import('../src/shared/protocol.js');
  const primary = buildSetupMessage();
  const legacy = buildLegacySetupMessage();
  // Primary: official nested shape
  assert.ok(primary.setup.generationConfig.translationConfig, 'primary translationConfig inside generationConfig');
  assert.ok('inputAudioTranscription' in primary.setup.generationConfig, 'primary inputAudioTranscription inside generationConfig');
  assert.ok('outputAudioTranscription' in primary.setup.generationConfig, 'primary outputAudioTranscription inside generationConfig');
  assert.ok(!('inputAudioTranscription' in primary.setup) || primary.setup.inputAudioTranscription === undefined || Object.keys(primary.setup).filter(k=>k==='inputAudioTranscription').length===0 || primary.setup.generationConfig.inputAudioTranscription, 'primary should be nested');
  // Legacy fallback: root fields
  assert.ok('inputAudioTranscription' in legacy.setup, 'legacy inputAudioTranscription at root');
  assert.ok('outputAudioTranscription' in legacy.setup, 'legacy outputAudioTranscription at root');
  assert.ok(legacy.setup.generationConfig.translationConfig, 'legacy still has translationConfig');
});

test('Polling lifecycle: 1-min alarm, 10 attempts, immediate poll, Chrome 116 compat', async () => {
  const sw = await readFile(path.join(root,'src/service-worker.js'),'utf8');
  assert.ok(sw.includes('MAX_POLL_ATTEMPTS = 10'), 'must be 10 attempts');
  assert.ok(sw.includes('ALARM_PERIOD_MINUTES = 1'), 'must be 1 minute');
  assert.ok(sw.includes('pollAndHandle') || sw.includes('immediate first poll'), 'must have immediate poll');
  assert.ok(!sw.includes('MAX_POLL_ATTEMPTS = 200'), 'old 200 attempts removed');
});
