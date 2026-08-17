import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  mapWithBoundedConcurrency,
  WORKING_DRAFT_STAGE_CONCURRENCY,
} from "../mail-working-draft-bounded";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("mapWithBoundedConcurrency", () => {
  it("keeps at most 3 tasks in flight and uses parallelism", async () => {
    const items = ["A", "B", "C", "D", "E"];
    const gates = items.map(() => deferred<string>());
    let active = 0;
    let maxActive = 0;

    const resultPromise = mapWithBoundedConcurrency(items, WORKING_DRAFT_STAGE_CONCURRENCY, (_, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return gates[index].promise.finally(() => {
        active -= 1;
      });
    });

    expect(active).toBe(3);
    expect(maxActive).toBe(3);

    gates[0].resolve("A");
    await tick();
    expect(active).toBe(3);

    for (const [index, value] of items.entries()) {
      gates[index].resolve(value);
      await tick();
    }

    await expect(resultPromise).resolves.toEqual(["A", "B", "C", "D", "E"]);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("preserves input order even when completion order is scrambled", async () => {
    const items = ["A", "B", "C", "D", "E"];
    const completionOrder = ["C", "A", "B", "E", "D"];
    const gates = new Map(items.map((item) => [item, deferred<string>()]));

    const resultPromise = mapWithBoundedConcurrency(items, WORKING_DRAFT_STAGE_CONCURRENCY, (item) =>
      gates.get(item)!.promise,
    );

    for (const item of completionOrder) {
      gates.get(item)!.resolve(item);
      await tick();
    }

    await expect(resultPromise).resolves.toEqual(["A", "B", "C", "D", "E"]);
  });

  it("waits for already-started tasks after one task fails", async () => {
    const items = ["A", "B", "C", "D", "E"];
    const gates = items.map(() => deferred<string>());
    let settled = 0;

    const resultPromise = mapWithBoundedConcurrency(items, WORKING_DRAFT_STAGE_CONCURRENCY, (_, index) => {
      return gates[index].promise.finally(() => {
        settled += 1;
      });
    });

    const rejection = expect(resultPromise).rejects.toThrow("B failed");
    gates[1].reject(new Error("B failed"));
    await tick();
    expect(settled).toBe(1);

    // A and C were already started and must be allowed to settle.
    gates[0].resolve("A");
    gates[2].resolve("C");
    await tick();
    expect(settled).toBe(3);

    await rejection;
  });
});

describe("Working Draft server attachment orchestration wiring", () => {
  const source = () =>
    readFileSync(new URL("../mail-working-draft.server.ts", import.meta.url), "utf8");

  it("uses the shared bounded helper for staging and external materialization", () => {
    const src = source();
    expect(src).toContain("WORKING_DRAFT_STAGE_CONCURRENCY");
    expect(src).toContain("mapWithBoundedConcurrency(");
  });

  it("collects handles from tasks that settle before a final cleanup", () => {
    const src = source();
    expect(src).toContain("const stagedHandles: string[] = []");
    expect(src).toContain("stagedHandles.push(handle);");
    expect(src).toContain("if (stagedHandles.length > 0)");
    expect(src).toContain("handles: stagedHandles");
  });
});
