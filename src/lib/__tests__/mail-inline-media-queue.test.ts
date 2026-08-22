import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  inlineMediaQueueSizeForTests,
  resetInlineMediaQueueForTests,
  runInlineMediaQueued,
  runInlineMediaWithBoundedRetry,
} from "@/lib/mail-inline-media-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => resetInlineMediaQueueForTests());

describe("visible CID media serialization", () => {
  it("never runs two media tasks for the same account in parallel", async () => {
    const hold = deferred();
    const started = deferred();
    const secondTask = vi.fn(async () => "second");

    const first = runInlineMediaQueued(
      "account-a",
      new AbortController().signal,
      "visible",
      async () => {
        started.resolve();
        await hold.promise;
        return "first";
      },
    );
    await started.promise;

    const second = runInlineMediaQueued(
      "account-a",
      new AbortController().signal,
      "visible",
      secondTask,
    );
    await Promise.resolve();
    expect(secondTask).not.toHaveBeenCalled();

    hold.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(secondTask).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(inlineMediaQueueSizeForTests()).toBe(0);
  });

  it("allows different accounts to hydrate independently", async () => {
    const hold = deferred();
    const startedA = deferred();
    const startedB = deferred();

    const a = runInlineMediaQueued("a", new AbortController().signal, "visible", async () => {
      startedA.resolve();
      await hold.promise;
      return "a";
    });
    await startedA.promise;

    const b = runInlineMediaQueued("b", new AbortController().signal, "visible", async () => {
      startedB.resolve();
      return "b";
    });
    await startedB.promise;
    await expect(b).resolves.toBe("b");
    hold.resolve();
    await expect(a).resolves.toBe("a");
  });

  it("does not start an aborted request that was waiting in the queue", async () => {
    const hold = deferred();
    const started = deferred();
    const staleController = new AbortController();
    const staleTask = vi.fn(async () => "stale");

    const first = runInlineMediaQueued("a", new AbortController().signal, "visible", async () => {
      started.resolve();
      await hold.promise;
      return "first";
    });
    await started.promise;

    const stale = runInlineMediaQueued("a", staleController.signal, "visible", staleTask);
    staleController.abort();
    hold.resolve();

    await first;
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(staleTask).not.toHaveBeenCalled();
  });

  it("preempts and resumes deferred work when a small visible image arrives", async () => {
    const firstAttemptStarted = deferred();
    const events: string[] = [];
    let attempts = 0;
    const large = runInlineMediaQueued(
      "a",
      new AbortController().signal,
      "deferred",
      async (attemptSignal) => {
        attempts += 1;
        events.push(`large-${attempts}-start`);
        if (attempts > 1) {
          events.push("large-complete");
          return "large";
        }
        firstAttemptStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          attemptSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
        return "never";
      },
    );
    await firstAttemptStarted.promise;

    const small = runInlineMediaQueued("a", new AbortController().signal, "visible", async () => {
      events.push("small-complete");
      return "small";
    });

    await expect(small).resolves.toBe("small");
    await expect(large).resolves.toBe("large");
    expect(events).toEqual(["large-1-start", "small-complete", "large-2-start", "large-complete"]);
  });

  it("bounds transient media-busy retry and stops retrying after abort", async () => {
    const task = vi
      .fn<() => Promise<{ retryable: boolean }>>()
      .mockResolvedValue({ retryable: true });
    await expect(
      runInlineMediaWithBoundedRetry(
        new AbortController().signal,
        task,
        ({ result }) => result?.retryable === true,
        { maxRetries: 1, delayMs: 0 },
      ),
    ).resolves.toEqual({ retryable: true });
    expect(task).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const abortingTask = vi.fn(async () => ({ retryable: true }));
    const pending = runInlineMediaWithBoundedRetry(
      controller.signal,
      abortingTask,
      ({ result }) => result?.retryable === true,
      { maxRetries: 2, delayMs: 10_000 },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(abortingTask).toHaveBeenCalledTimes(1);
  });

  it("wires only the two viewer CID network paths through the queue", () => {
    const source = readFileSync("src/routes/mail.tsx", "utf8");
    const viewer = source.slice(
      source.indexOf("function useInlineImageMappings"),
      source.indexOf("/** Body renderer"),
    );
    expect(viewer.split("runInlineMediaQueued(").length - 1).toBe(2);

    const openSource = readFileSync("src/lib/mail-message-open.functions.ts", "utf8");
    expect(openSource).not.toContain("runInlineMediaQueued");
  });
});
