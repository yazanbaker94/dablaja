import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureInstallIdentity } from '../src/shared/telemetry.js';
import { STORAGE_KEYS } from '../src/shared/constants.js';

const ID_KEY = STORAGE_KEYS.INSTALL_ID;
const CRED_KEY = STORAGE_KEYS.PLUS_INSTALL_CREDENTIAL;

// Deterministic in-memory chrome.storage.local double. The get() hook is
// gated behind a controllable promise so 20 simultaneous callers are all
// released inside the same single-flight window.
function makeChromeStub({ failSetTimes = 0 } = {}) {
  const store = new Map();
  let gateResolve = null;
  const gate = new Promise((resolve) => {
    gateResolve = resolve;
  });
  const state = { setCalls: [], failedSets: 0 };

  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          await gate;
          const out = {};
          for (const key of [].concat(keys)) out[key] = store.get(key);
          return out;
        },
        set: async (items) => {
          if (state.failedSets < failSetTimes) {
            state.failedSets += 1;
            throw new Error('storage unavailable');
          }
          state.setCalls.push(items);
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }
      }
    }
  };
  return {
    state,
    seed(key, value) {
      store.set(key, value);
    },
    openGate() {
      gateResolve();
    },
    cleanup() {
      delete globalThis.chrome;
    }
  };
}

test('20 simultaneous callers produce exactly one id/credential pair via a single generation+persist', async () => {
  const stub = makeChromeStub();
  try {
    // Hold every caller inside the shared in-flight window.
    const pending = Array.from({ length: 20 }, () => ensureInstallIdentity());
    assert.equal(stub.state.setCalls.length, 0, 'nothing persisted before the read completes');

    stub.openGate();

    const results = await Promise.all(pending);
    assert.equal(results.length, 20);

    const ids = new Set(results.map((r) => r.installId));
    const creds = new Set(results.map((r) => r.installCredential));
    assert.equal(ids.size, 1, 'exactly one installation ID generated');
    assert.equal(creds.size, 1, 'exactly one credential generated');
    assert.match(results[0].installId, /^[0-9a-f-]{36}$/, 'install id is a UUID');
    assert.match(results[0].installCredential, /^[0-9a-f]{64}$/, 'credential is 64 hex chars');

    for (const pair of results) {
      assert.equal(pair.installId, results[0].installId, 'every caller received the same install id');
      assert.equal(pair.installCredential, results[0].installCredential, 'every caller received the same credential');
    }

    assert.equal(stub.state.setCalls.length, 1, 'exactly one chrome.storage.local.set operation');
    const persisted = stub.state.setCalls[0];
    assert.equal(Object.keys(persisted).length, 2, 'both keys persisted in one call');
    assert.equal(persisted[ID_KEY], results[0].installId);
    assert.equal(persisted[CRED_KEY], results[0].installCredential);
  } finally {
    stub.cleanup();
  }
});

test('existing valid stored values are preserved and cause zero writes when already normalized', async () => {
  const stub = makeChromeStub();
  try {
    const existingId = 'existing-install-id-0123456789';
    const existingCred = 'ab'.repeat(32); // valid 64 lower hex chars
    stub.seed(ID_KEY, existingId);
    stub.seed(CRED_KEY, existingCred);

    const pending = Array.from({ length: 5 }, () => ensureInstallIdentity());
    stub.openGate();
    const results = await Promise.all(pending);

    for (const pair of results) {
      assert.equal(pair.installId, existingId, 'stored install id preserved');
      assert.equal(pair.installCredential.toLowerCase(), existingCred.toLowerCase(), 'stored credential preserved');
    }
    assert.equal(stub.state.setCalls.length, 0, 'no write when pair already valid and normalized');
  } finally {
    stub.cleanup();
  }
});

test('uppercase credential is normalized to lowercase with exactly one write', async () => {
  const stub = makeChromeStub();
  try {
    const existingId = 'existing-install-id-0123456789';
    const upperCred = 'AB'.repeat(32); // valid but needs lowercasing
    stub.seed(ID_KEY, existingId);
    stub.seed(CRED_KEY, upperCred);

    stub.openGate();
    const pending = ensureInstallIdentity();
    const result = await pending;

    assert.equal(result.installId, existingId);
    assert.equal(result.installCredential, upperCred.toLowerCase());
    assert.equal(stub.state.setCalls.length, 1, 'exactly one write to normalize credential');
    assert.equal(stub.state.setCalls[0][CRED_KEY], upperCred.toLowerCase());
    assert.equal(stub.state.setCalls[0][ID_KEY], existingId);
  } finally {
    stub.cleanup();
  }
});

test('malformed stored install id is replaced instead of causing permanent server rejection', async () => {
  const stub = makeChromeStub();
  try {
    stub.seed(ID_KEY, 'invalid install id with spaces');
    stub.seed(CRED_KEY, 'cd'.repeat(32));
    stub.openGate();
    const result = await ensureInstallIdentity();
    assert.match(result.installId, /^[0-9a-f-]{36}$/);
    assert.notEqual(result.installId, 'invalid install id with spaces');
    assert.equal(stub.state.setCalls.length, 1);
    assert.equal(stub.state.setCalls[0][ID_KEY], result.installId);
  } finally {
    stub.cleanup();
  }
});

test('storage failure rejects every joined caller and a later retry succeeds', async () => {
  const stub = makeChromeStub({ failSetTimes: 1 });
  try {
    const pending = Array.from({ length: 6 }, () => ensureInstallIdentity());
    stub.openGate();

    const outcomes = await Promise.allSettled(pending);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected', 'every joined caller rejects on storage failure');
      assert.match(String(outcome.reason?.message || ''), /storage unavailable/);
    }
    assert.equal(stub.state.setCalls.length, 0);

    // Retry after failure must be possible (in-flight promise cleared).
    const retry = Array.from({ length: 4 }, () => ensureInstallIdentity());
    const results = await Promise.all(retry);
    const ids = new Set(results.map((r) => r.installId));
    const creds = new Set(results.map((r) => r.installCredential));
    assert.equal(ids.size, 1, 'retry generates exactly one id');
    assert.equal(creds.size, 1, 'retry generates exactly one credential');
    assert.equal(stub.state.setCalls.length, 1, 'retry persists successfully');
  } finally {
    stub.cleanup();
  }
});

test('sequential callers after completion reuse the persisted values without extra writes', async () => {
  const stub = makeChromeStub();
  try {
    const pendingFirst = ensureInstallIdentity();
    stub.openGate();
    const first = await pendingFirst;
    assert.equal(stub.state.setCalls.length, 1, 'first wave wrote once');
    const second = await ensureInstallIdentity();
    const third = await ensureInstallIdentity();

    assert.equal(second.installId, first.installId);
    assert.equal(second.installCredential, first.installCredential);
    assert.deepEqual(third, first);
    assert.equal(stub.state.setCalls.length, 1, 'no extra writes after pair is persisted and normalized');
  } finally {
    stub.cleanup();
  }
});
