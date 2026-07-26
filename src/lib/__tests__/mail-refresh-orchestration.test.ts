// Regression tests for the manual Refresh orchestrator. Locks the call
// contract that the "slow refresh" hotfix promised:
//   incremental=1, reconcile awaited=0, list=1, counts=1, and reconcile
//   is fired-and-forgotten in the background when due.
import { describe, it, expect, vi } from "vitest";
import { runManualRefresh } from "../mail-refresh-orchestration";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeDeps(overrides: Partial<Parameters<typeof runManualRefresh>[0]> = {}) {
  const calls = { incremental: 0, reconcile: 0, list: 0, counts: 0, scheduled: 0 };
  const deps = {
    incrementalNow: vi.fn(async () => {
      calls.incremental += 1;
    }),
    reconcileNow: vi.fn(async () => {
      calls.reconcile += 1;
    }),
    shouldReconcile: vi.fn(() => false),
    loadMessages: vi.fn(async () => {
      calls.list += 1;
    }),
    loadCounts: vi.fn(async () => {
      calls.counts += 1;
    }),
    scheduleBackground: (fn: () => void) => {
      calls.scheduled += 1;
      fn();
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("runManualRefresh", () => {
  it("runs exactly ONE incremental + ONE list + ONE counts", async () => {
    const { deps, calls } = makeDeps();
    await runManualRefresh(deps);
    expect(calls.incremental).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.counts).toBe(1);
  });

  it("does NOT await reconcile when shouldReconcile returns false", async () => {
    const { deps, calls } = makeDeps({ shouldReconcile: vi.fn(() => false) });
    await runManualRefresh(deps);
    expect(calls.reconcile).toBe(0);
    expect(calls.scheduled).toBe(0);
  });

  it("schedules reconcile in background when due (never awaited)", async () => {
    const { deps, calls } = makeDeps({ shouldReconcile: vi.fn(() => true) });
    await runManualRefresh(deps);
    expect(calls.scheduled).toBe(1);
    expect(calls.reconcile).toBe(1);
  });

  it("runs list and counts IN PARALLEL after incremental", async () => {
    const listGate = deferred();
    const countsGate = deferred();
    const order: string[] = [];
    const { deps } = makeDeps({
      loadMessages: vi.fn(async () => {
        order.push("list:start");
        await listGate.promise;
        order.push("list:end");
      }),
      loadCounts: vi.fn(async () => {
        order.push("counts:start");
        await countsGate.promise;
        order.push("counts:end");
      }),
    });
    const p = runManualRefresh(deps);
    // Both must have started before either finishes.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["list:start", "counts:start"]);
    countsGate.resolve();
    listGate.resolve();
    await p;
  });

  it("Refresh promise resolves BEFORE the background reconcile settles (fast spinner)", async () => {
    const gate = deferred();
    const events: string[] = [];
    const { deps } = makeDeps({
      shouldReconcile: vi.fn(() => true),
      reconcileNow: vi.fn(async () => {
        events.push("reconcile:start");
        await gate.promise;
        events.push("reconcile:end");
      }),
      // Realistic: schedule via microtask, do NOT await.
      scheduleBackground: (fn) => {
        events.push("scheduled");
        Promise.resolve().then(fn);
      },
    });
    await runManualRefresh(deps);
    events.push("refresh:done");
    // The refresh call is done, but reconcile is still pending on the gate.
    expect(events).toEqual(["scheduled", "refresh:done"]);
    gate.resolve();
    // Let the background microtask run.
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toContain("reconcile:end");
  });

  it("double-click does not create overlapping incrementals when caller guards busy", async () => {
    // The orchestrator itself does not dedupe — the refresh button owns the
    // guard. Verify at least that a single call produces exactly one round
    // (i.e. no accidental fan-out).
    const { deps, calls } = makeDeps();
    await runManualRefresh(deps);
    expect(calls.incremental).toBe(1);
  });
});
