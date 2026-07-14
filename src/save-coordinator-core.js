/** Minimal save coordination helpers for debounced atomic workspace saves. */
export function createSaveCoordinator(options = {}) {
  const saveFn = options.saveFn;
  if (typeof saveFn !== "function") {
    throw new Error("saveFn is required");
  }
  let timer = null;
  let generation = 0;
  let inFlight = null;
  let pending = false;
  let lastError = null;
  let lastResult = null;

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) {
      pending = true;
      await inFlight;
      if (!pending) return lastResult;
    }
    pending = false;
    const myGen = ++generation;
    inFlight = (async () => {
      try {
        const result = await saveFn();
        if (myGen === generation) {
          lastError = null;
          lastResult = result;
        }
        return result;
      } catch (error) {
        if (myGen === generation) lastError = error;
        throw error;
      } finally {
        if (myGen === generation) inFlight = null;
      }
    })();
    const result = await inFlight;
    if (pending) {
      return flush();
    }
    return result;
  }

  function schedule(delayMs = 500) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
  }

  return {
    schedule,
    flush,
    isSaving: () => Boolean(inFlight),
    lastError: () => lastError,
    lastResult: () => lastResult,
  };
}
