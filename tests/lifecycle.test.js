import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, originOf, publicState } from '../src/shared/constants.js';
import { CleanupRegistry, canTransition, transitionState } from '../src/shared/lifecycle.js';

test('origin helper keeps only the site, not the full path', () => {
  assert.equal(originOf('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com');
  assert.equal(originOf('https://www.facebook.com/watch'), 'https://www.facebook.com');
});

test('lifecycle permits normal session and reconnect transitions', () => {
  assert.equal(canTransition(STATUS.READY, STATUS.CONNECTING), true);
  assert.equal(canTransition(STATUS.CONNECTING, STATUS.LISTENING), true);
  assert.equal(canTransition(STATUS.LISTENING, STATUS.TRANSLATING), true);
  assert.equal(canTransition(STATUS.TRANSLATING, STATUS.RECONNECTING), true);
  assert.equal(canTransition(STATUS.RECONNECTING, STATUS.LISTENING), true);
  assert.equal(canTransition(STATUS.NO_KEY, STATUS.TRANSLATING), false);
});

test('transitionState rejects impossible transitions', () => {
  const state = publicState({ status: STATUS.NO_KEY });
  assert.throws(() => transitionState(state, { status: STATUS.TRANSLATING }), /Invalid lifecycle transition/);
  assert.equal(transitionState(state, { status: STATUS.READY }).status, STATUS.READY);
});

test('cleanup registry is LIFO, fault tolerant, and idempotent', async () => {
  const events = [];
  const cleanup = new CleanupRegistry();
  cleanup.add(() => events.push('first'));
  cleanup.add(() => { throw new Error('expected test failure'); });
  cleanup.add(async () => events.push('last'));
  const failures = await cleanup.dispose();
  assert.deepEqual(events, ['last', 'first']);
  assert.equal(failures.length, 1);
  assert.deepEqual(await cleanup.dispose(), []);
  assert.throws(() => cleanup.add(() => undefined), /already disposed/);
});
