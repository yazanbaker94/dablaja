// Note-flush state machine — owns the debounced, ownership-checked note
// save used by the library detail view. Extracted so its guarantees are
// testable: single-write flushing, blocked navigation on failure, and no
// duplicate commits when blur races navigation.
//
// In-flight safety: a pending edit is NEVER discarded because an older
// commit is still running. The debounce path retains and reschedules it;
// flush() drains in-flight work first, then commits the newest pending
// value, repeating until nothing is pending. Navigation resolves true only
// after the newest value has been saved.

export function createNoteFlushController({
  commit,                                  // async (sessionId, value) => boolean
  debounceMs = 600,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof commit !== 'function') throw new Error('note-flush requires a commit function.');
  let pending = null;        // { sessionId, value, timer }
  let inFlight = null;       // Promise<boolean> for the running commit

  function clearTimer() {
    if (pending) clearTimeoutFn(pending.timer);
  }

  function takePending() {
    const current = pending;
    pending = null;
    if (current) clearTimeoutFn(current.timer);
    return current;
  }

  // Runs one commit; never rejects (a throwing commit counts as failure).
  function runCommit(sessionId, value) {
    inFlight = (async () => {
      try {
        return await commit(sessionId, value);
      } catch {
        return false;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedule(sessionId, value) {
    clearTimer();
    const timer = setTimeoutFn(() => {
      if (inFlight) {
        // Retain the pending edit and retry after the in-flight commit.
        arm(pending);
        return;
      }
      const current = takePending();
      if (current) runCommit(current.sessionId, current.value);
    }, debounceMs);
    pending = { sessionId, value, timer };
  }

  function arm(current) {
    if (!current) return;
    const timer = setTimeoutFn(() => {
      if (inFlight) {
        arm(pending);
        return;
      }
      const next = takePending();
      if (next) runCommit(next.sessionId, next.value);
    }, Math.max(20, Math.floor(debounceMs / 4)));
    pending = { sessionId: current.sessionId, value: current.value, timer };
  }

  // Single flush path: awaits any in-flight commit, then commits the newest
  // pending value, repeating until no pending edit remains. Resolves true
  // only when every value landed; a failed commit retains the edit for a
  // later retry and resolves false so interactive navigation can stop.
  async function flush() {
    let result = true;
    for (;;) {
      if (inFlight) await inFlight;
      const current = takePending();
      if (!current) return result;
      result = await runCommit(current.sessionId, current.value);
      if (result === false) {
        // Keep the failed value pending so the next flush retries it.
        arm(current);
        return false;
      }
    }
  }

  return {
    schedule,
    flush,
    hasPending: () => pending !== null
  };
}
