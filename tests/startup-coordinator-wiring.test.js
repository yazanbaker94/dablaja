import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLicenseRefreshCoordinator, REFRESH_ALARM_NAME } from '../src/shared/license-refresh-coordinator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('service-worker startup delegates to licenseRefresh.startupCheck() with no duplicate block', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  assert.match(sw, /await\s+licenseRefresh\.startupCheck\(\)/, 'worker must call licenseRefresh.startupCheck() directly');
  assert.doesNotMatch(
    sw,
    /Number\(lic\.lastCheckedAt\)[\s\S]*REFRESH_STALE_MS/,
    'duplicated stale/expired startup reconciliation block must not remain in the worker'
  );
  assert.doesNotMatch(
    sw,
    /license_id[\s\S]*credential_hash[\s\S]*IS NULL/,
    'legacy credential binding SQL must not remain duplicated in the worker'
  );
});

test('startup coordinator is importable and exposes the production path used by the worker', async () => {
  const mod = await import('../src/shared/license-refresh-coordinator.js');
  assert.equal(typeof mod.createLicenseRefreshCoordinator, 'function');
  assert.equal(mod.REFRESH_ALARM_NAME, REFRESH_ALARM_NAME);
  const c = mod.createLicenseRefreshCoordinator({
    storage: { get: async () => ({}), set: async () => {}, alarms: { getAll: async () => [], create: async () => {} } }
  });
  assert.equal(typeof c.startupCheck, 'function');
  assert.equal(typeof c.reconcileLicenseWithServer, 'function');
  assert.equal(typeof c.ensureRefreshAlarm, 'function');
});

test('every UI message waits for the shared worker initialization barrier', async () => {
  const sw = await readFile(path.join(root, 'src/service-worker.js'), 'utf8');
  const handler = sw.slice(
    sw.indexOf('async function handleUiMessage(message)'),
    sw.indexOf('let checkoutInFlight')
  );
  assert.match(
    handler,
    /async function handleUiMessage\(message\) \{\s*[\s\S]*?await initialStateReady;/,
    'payment, Plus and ordinary messages must not race storage/draft restoration'
  );
  assert.ok(
    handler.indexOf('await initialStateReady;') < handler.indexOf('WORKER_HANDLED_PLUS_TYPES.has'),
    'initialization barrier must precede the early PLUS_ routing branch'
  );
});
