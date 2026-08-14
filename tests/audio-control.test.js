import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveBufferPolicy, AdaptiveNoiseGate, calculateDuckedVolume } from '../src/shared/audio-control.js';

test('ducking respects base volume, activity, toggle, and safe bounds', () => {
  assert.equal(calculateDuckedVolume(0.5, true, true), 0.16);
  assert.equal(calculateDuckedVolume(0.5, true, false), 0.5);
  assert.equal(calculateDuckedVolume(0.5, false, true), 0.5);
  assert.equal(calculateDuckedVolume(5, false, false), 1.5);
  assert.equal(calculateDuckedVolume(-1, true, true), 0);
});

test('adaptive noise gate learns quiet background but opens for speech', () => {
  const gate = new AdaptiveNoiseGate();
  for (let index = 0; index < 100; index += 1) gate.update(0.0005);
  const quiet = gate.update(0.0006);
  const speech = gate.update(0.02);
  assert.equal(quiet.active, false);
  assert.equal(speech.active, true);
  assert.ok(quiet.threshold >= 0.0012);
  assert.ok(quiet.threshold <= 0.008);
});

test('adaptive buffer grows on underruns and never exceeds maximum', () => {
  const policy = new AdaptiveBufferPolicy();
  assert.equal(policy.targetMs, 280);
  assert.equal(policy.onUnderrun(), 320);
  for (let index = 0; index < 20; index += 1) policy.onUnderrun();
  assert.equal(policy.targetMs, 520);
});

test('adaptive buffer decays only after a stable interval', () => {
  const policy = new AdaptiveBufferPolicy();
  policy.onUnderrun();
  for (let index = 0; index < 19; index += 1) policy.onStableSecond();
  assert.equal(policy.targetMs, 320);
  policy.onStableSecond();
  assert.equal(policy.targetMs, 300);
});

test('backlog reset raises a low target but preserves a higher one', () => {
  const policy = new AdaptiveBufferPolicy();
  assert.equal(policy.onBacklogReset(), 300);
  policy.onUnderrun();
  policy.onUnderrun();
  policy.onUnderrun();
  assert.equal(policy.onBacklogReset(), 420);
});
