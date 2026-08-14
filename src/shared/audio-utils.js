export function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

export function floatToPcm16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampSample(samples[index]);
    output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return output;
}

export function pcm16ToFloat(samples) {
  const input = samples instanceof Int16Array ? samples : new Int16Array(samples);
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[index] < 0 ? input[index] / 32768 : input[index] / 32767;
  }
  return output;
}

export function interleavedToMono(channels) {
  if (!channels.length) return new Float32Array();
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const channel = channels[channelIndex];
    for (let index = 0; index < length; index += 1) mono[index] += channel[index];
  }
  const scale = 1 / channels.length;
  for (let index = 0; index < length; index += 1) mono[index] *= scale;
  return mono;
}

export function resampleLinear(input, inputRate, outputRate) {
  if (!input.length || inputRate <= 0 || outputRate <= 0) return new Float32Array();
  if (inputRate === outputRate) return new Float32Array(input);
  const outputLength = Math.max(1, Math.floor(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const block = 0x8000;
  for (let index = 0; index < bytes.length; index += block) {
    binary += String.fromCharCode(...bytes.subarray(index, index + block));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function alignPcm16Bytes(buffer, leftoverByte = null) {
  const incoming = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const prefix = leftoverByte == null ? 0 : 1;
  const total = prefix + incoming.length;
  if (!total) return { samples: new Int16Array(), leftover: leftoverByte };
  const even = total & ~1;
  const hasOdd = total % 2 === 1;
  const nextLeftover = hasOdd ? (incoming.length ? incoming[incoming.length - 1] : leftoverByte) : null;
  const bytes = new Uint8Array(even);
  if (prefix && even) bytes[0] = leftoverByte;
  const incomingTake = incoming.length - (hasOdd && incoming.length ? 1 : 0);
  if (incomingTake > 0) bytes.set(incoming.subarray(0, incomingTake), prefix && even ? 1 : 0);
  return {
    samples: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    leftover: nextLeftover
  };
}

export function rmsPcm16(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) {
    const value = sample / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export class BoundedQueue {
  constructor(maxItems) {
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new TypeError('maxItems must be positive');
    this.maxItems = maxItems;
    this.items = [];
    this.dropped = 0;
  }

  push(item) {
    this.items.push(item);
    while (this.items.length > this.maxItems) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  shift() {
    return this.items.shift();
  }

  clear() {
    this.items.length = 0;
  }

  get length() {
    return this.items.length;
  }
}
