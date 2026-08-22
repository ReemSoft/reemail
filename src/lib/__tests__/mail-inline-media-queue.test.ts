import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  inlineMediaQueueSizeForTests,
  resetInlineMediaQueueForTests,
  runInlineMediaQueued,
} from "@/lib/mail-inline-media-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => resetInlineMediaQueueForTests());

describe("visible CID media serialization", () => {
  it("never runs two media tasks for the same account in parallel", async () => {
    const hold = deferred();
    const started = deferred();
    const secondTask = vi.fn(async () => "second");

    const first = runInlineMediaQueued("account-a", new AbortController().signal, async () => {
      started.resolve();
      await hold.promise;
      return "first";
    });
    await started.promise;

    const second = runInlineMediaQueued("account-a", new AbortController().signal, secondTask);
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

    const a = runInlineMediaQueued("a", new AbortController().signal, async () => {
      startedA.resolve();
      await hold.promise;
      return "a";
    });
    await startedA.promise;

    const b = runInlineMediaQueued("b", new AbortController().signal, async () => {
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

    const first = runInlineMediaQueued("a", new AbortController().signal, async () => {
      started.resolve();
      await hold.promise;
      return "first";
    });
    await started.promise;

    const stale = runInlineMediaQueued("a", staleController.signal, staleTask);
    staleController.abort();
    hold.resolve();

    await first;
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(staleTask).not.toHaveBeenCalled();
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
