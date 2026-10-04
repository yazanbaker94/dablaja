class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16_000;
    this.chunkSamples = 1_600;
    this.ratio = sampleRate / this.targetRate;
    this.pendingInput = new Float32Array();
    this.phase = 0;
    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkOffset = 0;
  }

  appendInput(mono) {
    const merged = new Float32Array(this.pendingInput.length + mono.length);
    merged.set(this.pendingInput);
    merged.set(mono, this.pendingInput.length);

    while (this.phase + 1 < merged.length) {
      const left = Math.floor(this.phase);
      const fraction = this.phase - left;
      const sample = merged[left] + (merged[left + 1] - merged[left]) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.chunk[this.chunkOffset] = clamped < 0
        ? Math.round(clamped * 32768)
        : Math.round(clamped * 32767);
      this.chunkOffset += 1;
      this.phase += this.ratio;

      if (this.chunkOffset === this.chunkSamples) {
        const complete = this.chunk;
        this.port.postMessage({ type: 'PCM_CHUNK', buffer: complete.buffer }, [complete.buffer]);
        this.chunk = new Int16Array(this.chunkSamples);
        this.chunkOffset = 0;
      }
    }

    const consumed = Math.floor(this.phase);
    this.pendingInput = merged.slice(consumed);
    this.phase -= consumed;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const length = Math.min(...channels.map((channel) => channel.length));
    const mono = new Float32Array(length);
    for (const channel of channels) {
      for (let index = 0; index < length; index += 1) mono[index] += channel[index];
    }
    const scale = 1 / channels.length;
    for (let index = 0; index < length; index += 1) mono[index] *= scale;
    this.appendInput(mono);
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
