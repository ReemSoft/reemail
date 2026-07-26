// Regression tests for the single-flight guard used by the Refresh button.
// The React `refreshing` state alone can't stop a rapid double-click from
// spawning two concurrent incremental syncs — the guard MUST be a ref.
import { describe, it, expect, vi } from "vitest";
import { createSingleFlight } from "../single-flight";
import { runManualRefresh } from "../mail-refresh-orchestration";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSingleFlight", () => {
  it("returns the SAME promise for a second call while the first is in flight", async () => {
    const flight = createSingleFlight<void>();
    const gate = deferred();
    const fn = vi.fn(() => gate.promise);
    const p1 = flight.run(fn);
    const p2 = flight.run(fn);
    expect(p1).toBe(p2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(flight.isBusy()).toBe(true);
    gate.resolve();
    await p1;
    expect(flight.isBusy()).toBe(false);
  });

  it("allows a fresh call after the previous one settles (success)", async () => {
    const flight = createSingleFlight<void>();
    await flight.run(() => Promise.resolve());
    const fn = vi.fn(() => Promise.resolve());
    await flight.run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clears the guard after a rejected call so retry is possible", async () => {
    const flight = createSingleFlight<void>();
    await flight.run(() => Promise.reject(new Error("x"))).catch(() => {});
    expect(flight.isBusy()).toBe(false);
    const fn = vi.fn(() => Promise.resolve());
    await flight.run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("Refresh double-click contract (single-flight × runManualRefresh)", () => {
  it("double-click before the incremental resolves triggers exactly 1 incremental / 1 list / 1 counts", async () => {
    // Realistic gate: the first incremental blocks until we release it.
    const incGate = deferred();
    const incrementalNow = vi.fn(async () => {
      await incGate.promise;
    });
    const loadMessages = vi.fn(async () => {});
    const loadCounts = vi.fn(async () => {});
    const reconcileNow = vi.fn(async () => {});
    const shouldReconcile = vi.fn(() => false);

    const flight = createSingleFlight<void>();
    const kick = () =>
      flight.run(() =>
        runManualRefresh({
          incrementalNow,
          reconcileNow,
          shouldReconcile,
          loadMessages,
          loadCounts,
        }),
      );

    // Two rapid clicks BEFORE the first promise resolves.
    const p1 = kick();
    const p2 = kick();
    expect(p1).toBe(p2);
    // Release incremental → list + counts fire ONCE each.
    incGate.resolve();
    await p1;
    expect(incrementalNow).toHaveBeenCalledTimes(1);
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(loadCounts).toHaveBeenCalledTimes(1);
    expect(reconcileNow).not.toHaveBeenCalled();
  });
});
