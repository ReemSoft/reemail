import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireInlineCidFlight,
  inlineCidFlightCountForTests,
  resetInlineCidFlightsForTests,
} from "@/lib/mail-inline-cid-flight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => resetInlineCidFlightsForTests());

describe("visible CID request single-flight", () => {
  it("starts one physical request for duplicate visible CID consumers", async () => {
    const pending = deferred<string>();
    const start = vi.fn(async () => pending.promise);
    const first = acquireInlineCidFlight("message|part-2|logo", start);
    const second = acquireInlineCidFlight("message|part-2|logo", start);

    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(inlineCidFlightCountForTests()).toBe(1);
    pending.resolve("done");
    await expect(first.promise).resolves.toBe("done");
    await expect(second.promise).resolves.toBe("done");
    first.release();
    second.release();
  });

  it("aborts obsolete work only after the last viewer releases it", async () => {
    const observed = deferred<AbortSignal>();
    const first = acquireInlineCidFlight("message|part-2|logo", async (signal) => {
      observed.resolve(signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      return "never";
    });
    const second = acquireInlineCidFlight("message|part-2|logo", async () => "duplicate");
    const signal = await observed.promise;

    first.release();
    expect(signal.aborted).toBe(false);
    second.release();
    expect(signal.aborted).toBe(true);
    await expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    await expect(second.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(inlineCidFlightCountForTests()).toBe(0);
  });
});
