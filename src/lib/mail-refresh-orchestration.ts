// Pure orchestrator for the manual Refresh button.
//
// Contract (locked by unit tests):
//   1) incremental sync — exactly ONCE, awaited, with onSynced suppressed.
//   2) list + counts loaded IN PARALLEL — exactly ONCE each.
//   3) reconcile is NEVER awaited on the manual path. When
//      `shouldReconcile()` returns true, schedule it in the background so
//      the spinner ends as soon as the incremental round finishes.
//
// The bridge folder-counts fallback (an IMAP round-trip) is not called from
// here — the caller passes a `loadCounts` that prefers the Local Mail Index
// once the folder is ready.
export interface RefreshDeps {
  incrementalNow: (opts?: { suppressOnSynced?: boolean }) => Promise<void>;
  reconcileNow: (opts?: { suppressOnSynced?: boolean }) => Promise<void>;
  shouldReconcile: () => boolean;
  loadMessages: () => Promise<void>;
  loadCounts: () => Promise<void>;
  /**
   * Injection seam: schedule background work. Defaults to firing immediately
   * (still non-blocking, since the fn returns void). Tests override to
   * observe scheduling without racing.
   */
  scheduleBackground?: (fn: () => void) => void;
}

export async function runManualRefresh(deps: RefreshDeps): Promise<void> {
  await deps.incrementalNow({ suppressOnSynced: true });
  await Promise.all([deps.loadMessages(), deps.loadCounts()]);
  if (deps.shouldReconcile()) {
    const schedule =
      deps.scheduleBackground ??
      ((fn: () => void) => {
        // Fire-and-forget without blocking the caller.
        Promise.resolve().then(fn);
      });
    schedule(() => {
      // Defer the actual reconcile one more microtask so the caller's
      // `await runManualRefresh(...)` continuation runs FIRST — the spinner
      // ends before any reconcile work touches IMAP.
      queueMicrotask(() => {
        void deps.reconcileNow({ suppressOnSynced: true });
      });
    });
  }
}
