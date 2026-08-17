import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  coordinateSentCopyCompletion,
  createSentSyncCoalescer,
  runTargetedSentSync,
  watchSentCopy,
  type SentCopyWatchResult,
} from "@/lib/mail-sent-copy-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("post-send Sent-copy watcher", () => {
  it("does not start Sent sync while status remains pending", async () => {
    const watched = deferred<SentCopyWatchResult>();
    const requestSync = vi.fn();
    const completion = coordinateSentCopyCompletion({
      state: "pending",
      pending: true,
      hasJob: true,
      watch: () => watched.promise,
      requestSync,
      warnCopyFailure: vi.fn(),
    });
    await Promise.resolve();
    expect(requestSync).not.toHaveBeenCalled();
    watched.resolve("saved");
    await completion;
    expect(requestSync).toHaveBeenCalledOnce();
  });

  it("saved status requests exactly one Sent sync without watching", async () => {
    const watch = vi.fn();
    const requestSync = vi.fn();
    await coordinateSentCopyCompletion({
      state: "saved",
      pending: false,
      hasJob: false,
      watch,
      requestSync,
      warnCopyFailure: vi.fn(),
    });
    expect(watch).not.toHaveBeenCalled();
    expect(requestSync).toHaveBeenCalledOnce();
  });

  it("pending -> pending -> saved triggers one authoritative sync request", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, state: "pending" })
      .mockResolvedValueOnce({ ok: true, state: "pending" })
      .mockResolvedValueOnce({ ok: true, state: "saved" });
    const requestSync = vi.fn();
    await coordinateSentCopyCompletion({
      state: "pending",
      pending: true,
      hasJob: true,
      watch: () =>
        watchSentCopy({
          check,
          signal: new AbortController().signal,
          delays: [250, 500, 1_000],
          sleep: vi.fn().mockResolvedValue(undefined),
        }),
      requestSync,
      warnCopyFailure: vi.fn(),
    });
    expect(check).toHaveBeenCalledTimes(3);
    expect(requestSync).toHaveBeenCalledOnce();
  });

  it("Inbox -> Sent while pending refreshes counts then the current Sent list", async () => {
    let folder = "inbox";
    const order: string[] = [];
    await coordinateSentCopyCompletion({
      state: "pending",
      pending: true,
      hasJob: true,
      watch: async () => {
        folder = "sent";
        return "saved";
      },
      requestSync: () =>
        runTargetedSentSync({
          signal: new AbortController().signal,
          sentPath: "Physical/Sent",
          sync: async () => {
            order.push("sync");
            return { ok: true, busy: false };
          },
          refreshCounts: async () => void order.push("counts"),
          currentFolder: () => folder,
          refreshSentList: async () => void order.push("list"),
        }).then(() => undefined),
      warnCopyFailure: vi.fn(),
    });
    expect(order).toEqual(["sync", "counts", "list"]);
  });

  it("Sent -> Inbox while pending refreshes counts but never reloads Inbox", async () => {
    let folder = "sent";
    const order: string[] = [];
    await coordinateSentCopyCompletion({
      state: "pending",
      pending: true,
      hasJob: true,
      watch: async () => {
        folder = "inbox";
        return "saved";
      },
      requestSync: () =>
        runTargetedSentSync({
          signal: new AbortController().signal,
          sentPath: "Physical/Sent",
          sync: async () => {
            order.push("sync");
            return { ok: true, busy: false };
          },
          refreshCounts: async () => void order.push("counts"),
          currentFolder: () => folder,
          refreshSentList: async () => void order.push("list"),
        }).then(() => undefined),
      warnCopyFailure: vi.fn(),
    });
    expect(order).toEqual(["sync", "counts"]);
  });

  for (const state of ["failed", "rejected"] as const) {
    it(`${state} warns once and attempts one bounded fallback`, async () => {
      const warning = vi.fn();
      const requestSync = vi.fn();
      await coordinateSentCopyCompletion({
        state: state === "rejected" ? state : "pending",
        pending: state === "failed",
        hasJob: state === "failed",
        watch: async () => "failed",
        requestSync,
        warnCopyFailure: warning,
      });
      expect(warning).toHaveBeenCalledOnce();
      expect(requestSync).toHaveBeenCalledOnce();
    });
  }

  it("unknown/expired status performs one fallback without looping", async () => {
    const requestSync = vi.fn();
    await coordinateSentCopyCompletion({
      state: "pending",
      pending: true,
      hasJob: true,
      watch: async () => "unknown",
      requestSync,
      warnCopyFailure: vi.fn(),
    });
    expect(requestSync).toHaveBeenCalledOnce();
  });

  it("watch timeout is bounded and performs one fallback", async () => {
    const check = vi.fn().mockResolvedValue({ ok: true, state: "pending" });
    const requestSync = vi.fn();
    await coordinateSentCopyCompletion({
      state: "pending",
      pending: true,
      hasJob: true,
      watch: () =>
        watchSentCopy({
          check,
          signal: new AbortController().signal,
          delays: [250, 500, 1_000, 2_000, 4_000],
          sleep: vi.fn().mockResolvedValue(undefined),
        }),
      requestSync,
      warnCopyFailure: vi.fn(),
    });
    expect(check).toHaveBeenCalledTimes(5);
    expect(requestSync).toHaveBeenCalledOnce();
  });
});

describe("targeted Sent synchronization", () => {
  it("incremental busy once then success completes authoritatively", async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, busy: true })
      .mockResolvedValueOnce({ ok: true, busy: false });
    const counts = vi.fn().mockResolvedValue(undefined);
    const result = await runTargetedSentSync({
      signal: new AbortController().signal,
      sentPath: "Physical/Sent",
      sync,
      refreshCounts: counts,
      currentFolder: () => "inbox",
      refreshSentList: vi.fn(),
      busyRetryDelays: [250],
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toBe("synced");
    expect(sync).toHaveBeenCalledTimes(2);
    expect(counts).toHaveBeenCalledOnce();
  });

  it("uses exact Sent path, falls back on NO_CURSOR, then counts and current Sent list", async () => {
    let folder = "inbox";
    const order: string[] = [];
    const sync = vi
      .fn()
      .mockImplementationOnce(async (mode, path) => {
        order.push(`${mode}:${path}`);
        folder = "sent";
        return { ok: false, code: "NO_CURSOR" };
      })
      .mockImplementationOnce(async (mode, path) => {
        order.push(`${mode}:${path}`);
        return { ok: true, busy: false };
      });
    const result = await runTargetedSentSync({
      signal: new AbortController().signal,
      sentPath: "Archive/Physical Sent",
      sync,
      refreshCounts: async () => void order.push("counts"),
      currentFolder: () => folder,
      refreshSentList: async () => void order.push("list"),
    });
    expect(result).toBe("synced");
    expect(order).toEqual([
      "incremental:Archive/Physical Sent",
      "initial:Archive/Physical Sent",
      "counts",
      "list",
    ]);
  });

  it("fails closed without a Sent path and never guesses a mailbox", async () => {
    const sync = vi.fn();
    const result = await runTargetedSentSync({
      signal: new AbortController().signal,
      sentPath: undefined,
      sync,
      refreshCounts: vi.fn(),
      currentFolder: () => "sent",
      refreshSentList: vi.fn(),
    });
    expect(result).toBe("missing-path");
    expect(sync).not.toHaveBeenCalled();
  });

  it("returns aborted before the first sync request", async () => {
    const controller = new AbortController();
    controller.abort();
    const sync = vi.fn();
    const result = await runTargetedSentSync({
      signal: controller.signal,
      sentPath: "Physical/Sent",
      sync,
      refreshCounts: vi.fn(),
      currentFolder: () => "sent",
      refreshSentList: vi.fn(),
    });
    expect(result).toBe("aborted");
    expect(sync).not.toHaveBeenCalled();
  });

  it("returns aborted when cancellation interrupts a short busy retry", async () => {
    const controller = new AbortController();
    const sync = vi.fn().mockResolvedValue({ ok: true, busy: true });
    const resultPromise = runTargetedSentSync({
      signal: controller.signal,
      sentPath: "Physical/Sent",
      sync,
      refreshCounts: vi.fn(),
      currentFolder: () => "sent",
      refreshSentList: vi.fn(),
    });
    await Promise.resolve();
    controller.abort();
    expect(await resultPromise).toBe("aborted");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("aborts after NO_CURSOR without starting the initial fallback", async () => {
    const controller = new AbortController();
    const sync = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { ok: false, code: "NO_CURSOR" } as const;
    });
    const result = await runTargetedSentSync({
      signal: controller.signal,
      sentPath: "Physical/Sent",
      sync,
      refreshCounts: vi.fn(),
      currentFolder: () => "sent",
      refreshSentList: vi.fn(),
    });
    expect(result).toBe("aborted");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("aborts after sync success without refreshing counts or lists", async () => {
    const controller = new AbortController();
    const counts = vi.fn();
    const list = vi.fn();
    const result = await runTargetedSentSync({
      signal: controller.signal,
      sentPath: "Physical/Sent",
      sync: async () => {
        controller.abort();
        return { ok: true, busy: false };
      },
      refreshCounts: counts,
      currentFolder: () => "sent",
      refreshSentList: list,
    });
    expect(result).toBe("aborted");
    expect(counts).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("Sent sync busy coalescing", () => {
  it("Inbox -> Sent while pending refreshes the live Sent list after deferred busy success", async () => {
    vi.useFakeTimers();
    try {
      let folder = "inbox";
      const check = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, state: "pending" })
        .mockImplementationOnce(async () => {
          folder = "sent";
          return { ok: true, state: "saved" } as const;
        });
      const sync = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: false });
      const counts = vi.fn().mockResolvedValue(undefined);
      const list = vi.fn().mockResolvedValue(undefined);
      const coalescer = createSentSyncCoalescer((signal) =>
        runTargetedSentSync({
          signal,
          sentPath: "Physical/Sent",
          sync,
          refreshCounts: counts,
          currentFolder: () => folder,
          refreshSentList: list,
        }),
      );
      const completion = coordinateSentCopyCompletion({
        state: "pending",
        pending: true,
        hasJob: true,
        watch: () => watchSentCopy({ check, signal: new AbortController().signal }),
        requestSync: () => coalescer.request(),
        warnCopyFailure: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await completion;
      expect(sync).toHaveBeenCalledTimes(5);
      expect(counts).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Sent -> Inbox while pending refreshes counts without reloading Inbox after deferred success", async () => {
    vi.useFakeTimers();
    try {
      let folder = "sent";
      const check = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, state: "pending" })
        .mockImplementationOnce(async () => {
          folder = "inbox";
          return { ok: true, state: "saved" } as const;
        });
      const sync = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: true })
        .mockResolvedValueOnce({ ok: true, busy: false });
      const counts = vi.fn().mockResolvedValue(undefined);
      const list = vi.fn().mockResolvedValue(undefined);
      const coalescer = createSentSyncCoalescer((signal) =>
        runTargetedSentSync({
          signal,
          sentPath: "Physical/Sent",
          sync,
          refreshCounts: counts,
          currentFolder: () => folder,
          refreshSentList: list,
        }),
      );
      const completion = coordinateSentCopyCompletion({
        state: "pending",
        pending: true,
        hasJob: true,
        watch: () => watchSentCopy({ check, signal: new AbortController().signal }),
        requestSync: () => coalescer.request(),
        warnCopyFailure: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await completion;
      expect(sync).toHaveBeenCalledTimes(5);
      expect(counts).toHaveBeenCalledOnce();
      expect(list).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exhausted short retries get one deferred run that succeeds and refreshes once", async () => {
    const bridgeSync = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, busy: true })
      .mockResolvedValueOnce({ ok: true, busy: false });
    const counts = vi.fn().mockResolvedValue(undefined);
    const run = (signal: AbortSignal) =>
      runTargetedSentSync({
        signal,
        sentPath: "Physical/Sent",
        sync: bridgeSync,
        refreshCounts: counts,
        currentFolder: () => "inbox",
        refreshSentList: vi.fn(),
        busyRetryDelays: [],
      });
    const coalescer = createSentSyncCoalescer(run, {
      deferredBusyDelayMs: 3_000,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    await coalescer.request();
    expect(bridgeSync).toHaveBeenCalledTimes(2);
    expect(counts).toHaveBeenCalledOnce();
  });

  it("busy plus multiple message completions creates one eventual trailing run", async () => {
    const waiting = deferred<void>();
    let rounds = 0;
    const coalescer = createSentSyncCoalescer(async () => (++rounds === 1 ? "busy" : "synced"), {
      sleep: () => waiting.promise,
    });
    const first = coalescer.request();
    await Promise.resolve();
    const second = coalescer.request();
    const third = coalescer.request();
    waiting.resolve();
    await Promise.all([first, second, third]);
    expect(rounds).toBe(2);
  });

  it("never runs more than one active Sent sync and coalesces one trailing request", async () => {
    const blocked = deferred<void>();
    let active = 0;
    let maxActive = 0;
    let rounds = 0;
    const coalescer = createSentSyncCoalescer(async () => {
      rounds++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (rounds === 1) await blocked.promise;
      active--;
      return "synced";
    });
    const first = coalescer.request();
    const second = coalescer.request();
    const third = coalescer.request();
    blocked.resolve();
    await Promise.all([first, second, third]);
    expect(maxActive).toBe(1);
    expect(rounds).toBe(2);
  });

  it("persistent busy advances the real 6500ms schedule, warns, and never starts a ninth sync", async () => {
    vi.useFakeTimers();
    try {
      const warning = vi.fn();
      const sync = vi.fn().mockResolvedValue({ ok: true, busy: true });
      const counts = vi.fn();
      const coalescer = createSentSyncCoalescer(
        (signal) =>
          runTargetedSentSync({
            signal,
            sentPath: "Physical/Sent",
            sync,
            refreshCounts: counts,
            currentFolder: () => "sent",
            refreshSentList: vi.fn(),
          }),
        { onPersistentBusy: warning },
      );
      const flight = coalescer.request();
      expect(sync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_500);
      await flight;
      expect(sync).toHaveBeenCalledTimes(8);
      expect(counts).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledOnce();
      expect(coalescer.isRunning()).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { wait: 250, elapsed: 0, expectedCalls: 1 },
    { wait: 500, elapsed: 250, expectedCalls: 2 },
    { wait: 1_000, elapsed: 750, expectedCalls: 3 },
  ])(
    "dispose during the $wait ms short retry prevents the next sync",
    async ({ elapsed, expectedCalls }) => {
      vi.useFakeTimers();
      try {
        const sync = vi.fn().mockResolvedValue({ ok: true, busy: true });
        const warning = vi.fn();
        const coalescer = createSentSyncCoalescer(
          (signal) =>
            runTargetedSentSync({
              signal,
              sentPath: "Physical/Sent",
              sync,
              refreshCounts: vi.fn(),
              currentFolder: () => "sent",
              refreshSentList: vi.fn(),
            }),
          { onPersistentBusy: warning },
        );
        const flight = coalescer.request();
        if (elapsed > 0) await vi.advanceTimersByTimeAsync(elapsed);
        expect(sync).toHaveBeenCalledTimes(expectedCalls);
        coalescer.dispose();
        await vi.advanceTimersByTimeAsync(10_000);
        await flight;
        expect(sync).toHaveBeenCalledTimes(expectedCalls);
        expect(warning).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("account switch during the real 3000ms deferred wait starts neither old nor new sync", async () => {
    vi.useFakeTimers();
    try {
      const oldSync = vi.fn().mockResolvedValue({ ok: true, busy: true });
      const newSync = vi.fn().mockResolvedValue("synced");
      const oldCoordinator = createSentSyncCoalescer((signal) =>
        runTargetedSentSync({
          signal,
          sentPath: "Physical/Sent",
          sync: oldSync,
          refreshCounts: vi.fn(),
          currentFolder: () => "sent",
          refreshSentList: vi.fn(),
        }),
      );
      const oldFlight = oldCoordinator.request();
      await vi.advanceTimersByTimeAsync(1_750);
      expect(oldSync).toHaveBeenCalledTimes(4);
      oldCoordinator.dispose();
      const newCoordinator = createSentSyncCoalescer(newSync);
      await vi.advanceTimersByTimeAsync(10_000);
      await oldFlight;
      expect(oldSync).toHaveBeenCalledTimes(4);
      expect(newSync).not.toHaveBeenCalled();
      newCoordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an aborted coordinator outcome never warns", async () => {
    const warning = vi.fn();
    const coalescer = createSentSyncCoalescer(async () => "aborted", {
      onPersistentBusy: warning,
    });
    await coalescer.request();
    expect(warning).not.toHaveBeenCalled();
  });

  it("dispose during deferred busy wait cancels the timer and prevents later sync", async () => {
    const run = vi.fn().mockResolvedValue("busy");
    const sleep = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
        }),
    );
    const warning = vi.fn();
    const coalescer = createSentSyncCoalescer(run, {
      sleep,
      onPersistentBusy: warning,
    });
    const flight = coalescer.request();
    await Promise.resolve();
    coalescer.dispose();
    await flight;
    expect(run).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
    await coalescer.request();
    expect(run).toHaveBeenCalledOnce();
  });

  it("an account switch cannot redirect an old captured request into the new coordinator", async () => {
    const oldRun = vi.fn().mockResolvedValue("synced");
    const newRun = vi.fn().mockResolvedValue("synced");
    const oldCoordinator = createSentSyncCoalescer(oldRun);
    const requestForOldAccount = () => oldCoordinator.request();
    oldCoordinator.dispose();
    const newCoordinator = createSentSyncCoalescer(newRun);
    await requestForOldAccount();
    expect(oldRun).not.toHaveBeenCalled();
    expect(newRun).not.toHaveBeenCalled();
    newCoordinator.dispose();
  });
});

describe("static post-send safety", () => {
  it("keeps status separate from message-open and uses background sync gates", () => {
    const mail = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
    const bridge = readFileSync(new URL("../../../bridge/src/index.ts", import.meta.url), "utf8");
    expect(mail).toContain('fetch("/api/mail-sent-copy-status"');
    expect(mail).toMatch(/onClose\(\{ refreshDrafts: false \}\);\s*onSent\(\{/);
    expect(bridge).toMatch(
      /app\.post\("\/api\/sync\/(?:initial|incremental)", requireKey, imapGate\("background"\)/,
    );
    expect(mail).not.toMatch(/openMailMessage[\s\S]{0,200}mail-sent-copy-status/);
  });

  it("status proxy resolves account server-side and forwards no browser account or password", () => {
    const route = readFileSync(
      new URL("../../routes/api/mail-sent-copy-status.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain("resolveBridgeAuth(token)");
    expect(route).toContain("account: auth.bridgeAccount, jobId");
    expect(route).not.toMatch(/body\?\.account|body\?\.password/);
    expect(route).toContain('"X-Bridge-Key": auth.bridgeKey');
  });
});
