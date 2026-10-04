export function calculateDuckedVolume(baseVolume, autoDucking, playbackActive, duckScale = 0.32) {
  const base = Math.max(0, Math.min(1.5, Number(baseVolume) || 0));
  const scale = autoDucking && playbackActive ? Math.max(0, Math.min(1, duckScale)) : 1;
  return base * scale;
}

export function calculateTailFade(queuedSamples, fadeSamples) {
  const remaining = Math.max(0, Number(queuedSamples) || 0);
  const duration = Math.max(1, Number(fadeSamples) || 1);
  return Math.min(1, (remaining + 1) / duration);
}

export class AdaptiveNoiseGate {
  constructor({ initialNoiseFloor = 0.0004, minimum = 0.0012, maximum = 0.008, multiplier = 3.5 } = {}) {
    this.noiseFloor = initialNoiseFloor;
    this.minimum = minimum;
    this.maximum = maximum;
    this.multiplier = multiplier;
  }

  update(rms) {
    const safeRms = Math.max(0, Number(rms) || 0);
    if (safeRms < 0.02) this.noiseFloor = this.noiseFloor * 0.97 + safeRms * 0.03;
    const threshold = Math.max(this.minimum, Math.min(this.maximum, this.noiseFloor * this.multiplier));
    return { active: safeRms >= threshold, threshold, noiseFloor: this.noiseFloor };
  }
}

export class AdaptiveBufferPolicy {
  constructor({ minimumMs = 280, maximumMs = 520, increaseMs = 40, decreaseMs = 20, stableSeconds = 20 } = {}) {
    this.minimumMs = minimumMs;
    this.maximumMs = maximumMs;
    this.increaseMs = increaseMs;
    this.decreaseMs = decreaseMs;
    this.stableSeconds = stableSeconds;
    this.targetMs = minimumMs;
    this.secondsWithoutUnderrun = 0;
  }

  onUnderrun() {
    this.secondsWithoutUnderrun = 0;
    this.targetMs = Math.min(this.maximumMs, this.targetMs + this.increaseMs);
    return this.targetMs;
  }

  onStableSecond() {
    this.secondsWithoutUnderrun += 1;
    if (this.secondsWithoutUnderrun >= this.stableSeconds && this.targetMs > this.minimumMs) {
      this.targetMs = Math.max(this.minimumMs, this.targetMs - this.decreaseMs);
      this.secondsWithoutUnderrun = 0;
    }
    return this.targetMs;
  }

  onBacklogReset() {
    this.secondsWithoutUnderrun = 0;
    this.targetMs = Math.max(this.targetMs, Math.min(this.maximumMs, 300));
    return this.targetMs;
  }
}
