// Tiny single-flight primitive: while a call is in flight, subsequent
// callers receive the SAME promise instead of starting a new run. Cleared
// atomically in `finally` so a rejected/settled call can be retried.
//
// Used by the Refresh button so a rapid double-click cannot spawn two
// concurrent incremental syncs — the React `refreshing` state alone is
// insufficient because two synchronous clicks both read the stale value
// before the re-render.
export function createSingleFlight<T = void>() {
  let inFlight: Promise<T> | null = null;
  function run(fn: () => Promise<T>): Promise<T> {
    if (inFlight) return inFlight;
    const p = fn().finally(() => {
      inFlight = null;
    });
    inFlight = p;
    return p;
  }
  function isBusy(): boolean {
    return inFlight !== null;
  }
  return { run, isBusy };
}
