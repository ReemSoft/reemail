import { describe, expect, it, vi } from "vitest";
import {
  AdaptivePrefetchQueue,
  abortInflightControllers,
  adjacentPrefetchIds,
  cancelScheduledPrefetch,
  firstVisiblePrefetchIds,
  shouldUseWidePrefetch,
} from "../mail-prefetch";

describe("MAILMAESTRO_INSTANT_NAVIGATION_R1 adaptive prefetch", () => {
  it("limits idle warming to the first five rows and adjacent warming to ±2", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `inbox:${index + 1}`);
    expect(firstVisiblePrefetchIds(ids)).toEqual(ids.slice(0, 5));
    expect(adjacentPrefetchIds(ids, "inbox:5")).toEqual([
      "inbox:4",
      "inbox:6",
      "inbox:3",
      "inbox:7",
    ]);
  });

  it("deduplicates requests, keeps concurrency at one, and promotes foreground-adjacent work", async () => {
    const queue = new AdaptivePrefetchQueue<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task =
      (name: string, wait = false) =>
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(name);
        if (wait) await gate;
        active--;
        return name;
      };
    const running = queue.enqueue("running", "visible", task("running", true));
    const visible = queue.enqueue("visible", "visible", task("visible"));
    const adjacent = queue.enqueue("adjacent", "adjacent", task("adjacent"));
    const duplicate = queue.enqueue("adjacent", "hover", vi.fn(task("duplicate")));
    expect(duplicate).toBe(adjacent);
    release();
    await Promise.all([running, visible, adjacent, duplicate]);
    expect(order).toEqual(["running", "adjacent", "visible"]);
    expect(maxActive).toBe(1);
  });

  it("reduces speculative work for Save-Data and 2G", () => {
    expect(shouldUseWidePrefetch({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(shouldUseWidePrefetch({ effectiveType: "2g" })).toBe(false);
    expect(shouldUseWidePrefetch({ effectiveType: "4g" })).toBe(true);
  });

  it("aborts running work and drains timers/maps after repeated scope cancellation", async () => {
    const queue = new AdaptivePrefetchQueue<string>();
    let aborts = 0;
    const running = queue.enqueue("old", "visible", async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborts++;
            resolve();
          },
          { once: true },
        );
      });
      return "old";
    });
    for (let index = 0; index < 100; index++) queue.cancelAll();
    await running;
    await vi.waitFor(() => expect(queue.isRunning()).toBe(false));
    expect(aborts).toBe(1);
    expect(queue.pendingKeys()).toEqual([]);
  });

  it("does not let completion of an old task delete a newer promise with the same key", async () => {
    const queue = new AdaptivePrefetchQueue<string>();
    let releaseOld!: () => void;
    const old = queue.enqueue(
      "same",
      "visible",
      () => new Promise<string>((resolve) => (releaseOld = () => resolve("old"))),
    );
    queue.cancelAll();
    const newer = queue.enqueue("same", "adjacent", async () => "new");
    releaseOld();
    await old;
    expect(await newer).toBe("new");
    expect(queue.pendingKeys()).toEqual([]);
  });

  it("returns timers, idle callbacks, requests and queue state to zero after 100 scope switches", async () => {
    const timers = new Map<string, number>();
    const requests = new Map<string, { controller: AbortController }>();
    const queue = new AdaptivePrefetchQueue<string>();
    let clearedTimers = 0;
    let cancelledIdle = 0;
    let aborted = 0;
    for (let scope = 0; scope < 100; scope++) {
      timers.set(`hover-${scope}`, scope);
      const controller = new AbortController();
      controller.signal.addEventListener("abort", () => aborted++, { once: true });
      requests.set(`request-${scope}`, { controller });
      void queue.enqueue(`queued-${scope}`, "visible", async () => "done");
      cancelScheduledPrefetch(
        timers,
        () => cancelledIdle++,
        () => clearedTimers++,
      );
      abortInflightControllers(requests);
      queue.cancelAll();
    }
    await vi.waitFor(() => expect(queue.isRunning()).toBe(false));
    expect(timers.size).toBe(0);
    expect(requests.size).toBe(0);
    expect(queue.pendingKeys()).toEqual([]);
    expect(clearedTimers).toBe(100);
    expect(cancelledIdle).toBe(100);
    expect(aborted).toBe(100);
  });
});
