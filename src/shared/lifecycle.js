import { STATUS } from './constants.js';

const COMMON_TERMINALS = new Set([STATUS.ERROR, STATUS.STOPPED, STATUS.NO_KEY]);
const transitions = new Map([
  [STATUS.NO_KEY, new Set([STATUS.NO_KEY, STATUS.READY, STATUS.ERROR])],
  [STATUS.READY, new Set([STATUS.READY, STATUS.CONNECTING, ...COMMON_TERMINALS])],
  [STATUS.CONNECTING, new Set([STATUS.CONNECTING, STATUS.LISTENING, STATUS.RECONNECTING, STATUS.RATE_LIMITED, ...COMMON_TERMINALS])],
  [STATUS.LISTENING, new Set([STATUS.LISTENING, STATUS.TRANSLATING, STATUS.RECONNECTING, STATUS.RATE_LIMITED, ...COMMON_TERMINALS])],
  [STATUS.TRANSLATING, new Set([STATUS.TRANSLATING, STATUS.LISTENING, STATUS.RECONNECTING, STATUS.RATE_LIMITED, ...COMMON_TERMINALS])],
  [STATUS.RECONNECTING, new Set([STATUS.RECONNECTING, STATUS.CONNECTING, STATUS.LISTENING, STATUS.RATE_LIMITED, ...COMMON_TERMINALS])],
  [STATUS.RATE_LIMITED, new Set([STATUS.RATE_LIMITED, STATUS.RECONNECTING, STATUS.CONNECTING, STATUS.LISTENING, ...COMMON_TERMINALS])],
  [STATUS.STOPPED, new Set([STATUS.STOPPED, STATUS.READY, STATUS.CONNECTING, STATUS.NO_KEY, STATUS.ERROR])],
  [STATUS.ERROR, new Set([STATUS.ERROR, STATUS.STOPPED, STATUS.READY, STATUS.CONNECTING, STATUS.NO_KEY])]
]);

export function canTransition(from, to) {
  return Boolean(transitions.get(from)?.has(to));
}

export function transitionState(current, patch) {
  if (patch.status && patch.status !== current.status && !canTransition(current.status, patch.status)) {
    throw new Error(`Invalid lifecycle transition: ${current.status} -> ${patch.status}`);
  }
  return { ...current, ...patch };
}

export class CleanupRegistry {
  constructor() {
    this.cleanups = [];
    this.disposed = false;
  }

  add(cleanup) {
    if (this.disposed) throw new Error('Cleanup registry already disposed');
    if (typeof cleanup !== 'function') throw new TypeError('Cleanup must be a function');
    this.cleanups.push(cleanup);
    return cleanup;
  }

  async dispose() {
    if (this.disposed) return [];
    this.disposed = true;
    const failures = [];
    while (this.cleanups.length) {
      try {
        await this.cleanups.pop()();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}
