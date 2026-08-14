import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedQueue,
  alignPcm16Bytes,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  floatToPcm16,
  interleavedToMono,
  pcm16ToFloat,
  resampleLinear,
  rmsPcm16
} from '../src/shared/audio-utils.js';

test('PCM16 conversion clamps endpoints and round-trips ordinary samples', () => {
  const input = new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]);
  const pcm = floatToPcm16(input);
  assert.deepEqual([...pcm], [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  const decoded = pcm16ToFloat(pcm);
  assert.ok(Math.abs(decoded[2] + 0.5) < 0.0001);
  assert.ok(Math.abs(decoded[4] - 0.5) < 0.0001);
});

test('channel conversion averages channels and respects shortest boundary', () => {
  const mono = interleavedToMono([
    new Float32Array([1, 0, -1]),
    new Float32Array([-1, 1])
  ]);
  assert.deepEqual([...mono], [0, 0.5]);
});

test('linear resampling returns correct length and stable boundaries', () => {
  const down = resampleLinear(new Float32Array([0, 1, 0, -1, 0, 1]), 48_000, 16_000);
  assert.equal(down.length, 2);
  assert.equal(down[0], 0);
  assert.equal(down[1], -1);
  const empty = resampleLinear(new Float32Array(), 48_000, 16_000);
  assert.equal(empty.length, 0);
});

test('base64 conversion preserves little-endian PCM bytes', () => {
  const pcm = new Int16Array([-32768, -1, 0, 1, 32767]);
  const encoded = arrayBufferToBase64(pcm.buffer);
  const restored = new Int16Array(base64ToArrayBuffer(encoded));
  assert.deepEqual([...restored], [...pcm]);
});

test('bounded queue drops oldest items and tracks drops', () => {
  const queue = new BoundedQueue(2);
  queue.push('a');
  queue.push('b');
  queue.push('c');
  assert.equal(queue.length, 2);
  assert.equal(queue.dropped, 1);
  assert.equal(queue.shift(), 'b');
  queue.clear();
  assert.equal(queue.length, 0);
});

test('PCM16 alignment carries an odd leftover byte into the next chunk', () => {
  const first = alignPcm16Bytes(new Uint8Array([0x01, 0x00, 0x02]));
  assert.deepEqual([...first.samples], [1]);
  assert.equal(first.leftover, 0x02);
  const held = alignPcm16Bytes(new Uint8Array(), first.leftover);
  assert.equal(held.samples.length, 0);
  assert.equal(held.leftover, 0x02);
  const second = alignPcm16Bytes(new Uint8Array([0x00, 0x03, 0x00]), first.leftover);
  assert.deepEqual([...second.samples], [2, 3]);
  assert.equal(second.leftover, null);
});

test('RMS distinguishes silence from activity', () => {
  assert.equal(rmsPcm16(new Int16Array(100)), 0);
  assert.ok(rmsPcm16(new Int16Array([1000, -1000, 1000, -1000])) > 0.02);
});
