import { AdaptiveBufferPolicy } from '../shared/audio-control.js';
import { alignPcm16Bytes } from '../shared/audio-utils.js';

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceRate = 24_000;
    this.ratio = this.sourceRate / sampleRate;
    this.pendingSource = new Float32Array();
    this.pendingOddByte = null;
    this.phase = 0;
    this.queue = [];
    this.queueOffset = 0;
    this.queuedSamples = 0;
    this.maxSamples = Math.round(sampleRate * 2.5);
    this.targetSamples = Math.round(sampleRate * 1.2);
    this.bufferPolicy = new AdaptiveBufferPolicy();
    this.prebufferSamples = Math.round(sampleRate * this.bufferPolicy.targetMs / 1000);
    this.hardUnderrunSamples = Math.round(sampleRate * 0.08);
    this.playing = false;
    this.reportFrames = 0;
    this.underruns = 0;
    this.drySamples = 0;
    this.fadeSamples = Math.max(1, Math.round(sampleRate * 0.012));
    this.envelope = 0;

    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ENQUEUE' && data.buffer) this.enqueue(data.buffer);
      if (data?.type === 'CLEAR') this.clear();
    };
  }

  enqueue(buffer) {
    const aligned = alignPcm16Bytes(buffer, this.pendingOddByte);
    this.pendingOddByte = aligned.leftover;
    const pcm = aligned.samples;
    if (!pcm.length) return;

    const source = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) {
      source[index] = pcm[index] < 0 ? pcm[index] / 32768 : pcm[index] / 32767;
    }

    const merged = new Float32Array(this.pendingSource.length + source.length);
    merged.set(this.pendingSource);
    merged.set(source, this.pendingSource.length);
    const output = [];
    while (this.phase + 1 < merged.length) {
      const left = Math.floor(this.phase);
      const fraction = this.phase - left;
      output.push(merged[left] + (merged[left + 1] - merged[left]) * fraction);
      this.phase += this.ratio;
    }
    const consumed = Math.floor(this.phase);
    this.pendingSource = merged.slice(consumed);
    this.phase -= consumed;

    if (output.length) {
      const chunk = Float32Array.from(output);
      this.queue.push(chunk);
      this.queuedSamples += chunk.length;
    }

    if (this.queuedSamples > this.maxSamples) {
      while (this.queue.length && this.queuedSamples > this.targetSamples) {
        const dropped = this.queue.shift();
        this.queuedSamples -= dropped.length - this.queueOffset;
        this.queueOffset = 0;
      }
      this.queuedSamples = Math.max(0, this.queuedSamples);
      this.prebufferSamples = Math.round(sampleRate * this.bufferPolicy.onBacklogReset() / 1000);
      this.setPlaying(false);
      this.port.postMessage({ type: 'BUFFER_RESET' });
    }
  }

  clear() {
    this.queue.length = 0;
    this.queueOffset = 0;
    this.queuedSamples = 0;
    this.pendingSource = new Float32Array();
    this.pendingOddByte = null;
    this.phase = 0;
    this.drySamples = 0;
    this.setPlaying(false);
    this.envelope = 0;
  }

  setPlaying(value) {
    if (this.playing === value) return;
    this.playing = value;
    this.port.postMessage({ type: 'PLAYBACK_ACTIVE', active: value });
  }

  nextSample() {
    if (!this.queue.length) return null;
    const current = this.queue[0];
    const sample = current[this.queueOffset];
    this.queueOffset += 1;
    this.queuedSamples -= 1;
    if (this.queueOffset >= current.length) {
      this.queue.shift();
      this.queueOffset = 0;
    }
    return sample;
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels?.length) return true;
    const output = channels[0];
    output.fill(0);

    if (!this.playing && this.queuedSamples >= this.prebufferSamples) {
      this.envelope = 0;
      this.drySamples = 0;
      this.setPlaying(true);
    }

    if (this.playing) {
      for (let index = 0; index < output.length; index += 1) {
        const sample = this.nextSample();
        if (sample === null) {
          this.drySamples += output.length - index;
          if (this.drySamples >= this.hardUnderrunSamples) {
            this.underruns += 1;
            this.prebufferSamples = Math.round(sampleRate * this.bufferPolicy.onUnderrun() / 1000);
            this.setPlaying(false);
            this.envelope = 0;
          }
          break;
        }
        this.drySamples = 0;
        if (this.envelope < 1) this.envelope = Math.min(1, this.envelope + 1 / this.fadeSamples);
        output[index] = sample * this.envelope;
      }
    }

    for (let channelIndex = 1; channelIndex < channels.length; channelIndex += 1) {
      channels[channelIndex].set(output);
    }

    this.reportFrames += output.length;
    if (this.reportFrames >= sampleRate) {
      this.reportFrames = 0;
      this.prebufferSamples = Math.round(sampleRate * this.bufferPolicy.onStableSecond() / 1000);
      this.port.postMessage({
        type: 'BUFFER_STATUS',
        bufferMs: Math.round(this.queuedSamples * 1000 / sampleRate),
        targetBufferMs: Math.round(this.prebufferSamples * 1000 / sampleRate),
        underruns: this.underruns,
        playing: this.playing
      });
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
