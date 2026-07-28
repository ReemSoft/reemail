import { describe, it, expect, vi } from "vitest";
import {
  createAutosaveScheduler,
  attachInputListener,
  attachBeforeUnloadGuard,
  isDraftEmpty,
} from "../mail-composer-autosave";
import { createSingleFlight } from "../single-flight";

describe("createAutosaveScheduler", () => {
  it("fires onFire once after the delay", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 800, onFire });
    s.schedule();
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(799);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("coalesces rapid schedule() calls into a single fire", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 800, onFire });
    for (let i = 0; i < 10; i++) {
      s.schedule();
      vi.advanceTimersByTime(50);
    }
    // Only ~500ms have elapsed and every call reset the timer; nothing yet.
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("flushNow fires synchronously and cancels the pending timer", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 800, onFire });
    s.schedule();
    s.flushNow();
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("dispose cancels the timer — no callback afterwards", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 800, onFire });
    s.schedule();
    s.dispose();
    vi.advanceTimersByTime(5_000);
    expect(onFire).not.toHaveBeenCalled();
    // schedule() after dispose is a no-op.
    s.schedule();
    vi.advanceTimersByTime(5_000);
    expect(onFire).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("dispose is idempotent", () => {
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 800, onFire });
    expect(() => {
      s.dispose();
      s.dispose();
      s.dispose();
    }).not.toThrow();
  });

  it("dispose called during a scheduled window prevents an already-in-flight timer from firing", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 100, onFire });
    s.schedule();
    vi.advanceTimersByTime(50);
    s.dispose();
    vi.advanceTimersByTime(500);
    expect(onFire).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

function fakeTarget() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    listeners,
    addEventListener(type: string, fn: (e: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: string, evt: unknown) {
      for (const fn of listeners.get(type) ?? new Set()) fn(evt);
    },
    countFor(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe("attachInputListener", () => {
  it("invokes handler on input event; dispose removes it", () => {
    const t = fakeTarget();
    const handler = vi.fn();
    const d = attachInputListener(t, handler);
    expect(t.countFor("input")).toBe(1);
    t.emit("input", {});
    t.emit("input", {});
    expect(handler).toHaveBeenCalledTimes(2);
    d.dispose();
    expect(t.countFor("input")).toBe(0);
    t.emit("input", {});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("dispose is idempotent and only removes the listener once", () => {
    const t = fakeTarget();
    const handler = vi.fn();
    const d = attachInputListener(t, handler);
    d.dispose();
    d.dispose();
    d.dispose();
    expect(t.countFor("input")).toBe(0);
  });

  it("handler does NOT fire after dispose even for late-dispatched events", () => {
    const t = fakeTarget();
    const handler = vi.fn();
    const d = attachInputListener(t, handler);
    d.dispose();
    t.emit("input", {});
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("attachBeforeUnloadGuard", () => {
  it("preventDefault + returnValue set when dirty=true", () => {
    const t = fakeTarget();
    const guard = attachBeforeUnloadGuard(t as unknown as Window, () => true);
    const evt = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    t.emit("beforeunload", evt);
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(evt.returnValue).toBe("");
    guard.dispose();
  });

  it("no-op when dirty=false", () => {
    const t = fakeTarget();
    const guard = attachBeforeUnloadGuard(t as unknown as Window, () => false);
    const evt = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    t.emit("beforeunload", evt);
    expect(evt.preventDefault).not.toHaveBeenCalled();
    expect(evt.returnValue).toBeUndefined();
    guard.dispose();
  });

  it("dispose removes listener and is idempotent", () => {
    const t = fakeTarget();
    const guard = attachBeforeUnloadGuard(t as unknown as Window, () => true);
    expect(t.countFor("beforeunload")).toBe(1);
    guard.dispose();
    guard.dispose();
    guard.dispose();
    expect(t.countFor("beforeunload")).toBe(0);
    const evt = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    t.emit("beforeunload", evt);
    expect(evt.preventDefault).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------- isDraftEmpty
describe("isDraftEmpty (unified emptiness contract)", () => {
  const base = {
    toCount: 0,
    ccCount: 0,
    bccCount: 0,
    subject: "",
    htmlTrimmed: "",
    existingKeptCount: 0,
    filesCount: 0,
  };

  it("empty on every zero field", () => {
    expect(isDraftEmpty(base)).toBe(true);
  });

  it("attachment-only (new file) is NOT empty", () => {
    expect(isDraftEmpty({ ...base, filesCount: 1 })).toBe(false);
  });

  it("attachment-only (kept legacy) is NOT empty", () => {
    expect(isDraftEmpty({ ...base, existingKeptCount: 1 })).toBe(false);
  });

  it("mixed attachments (kept + new) are NOT empty", () => {
    expect(isDraftEmpty({ ...base, existingKeptCount: 2, filesCount: 3 })).toBe(false);
  });

  it("any recipient or subject or html marks non-empty", () => {
    expect(isDraftEmpty({ ...base, toCount: 1 })).toBe(false);
    expect(isDraftEmpty({ ...base, ccCount: 1 })).toBe(false);
    expect(isDraftEmpty({ ...base, bccCount: 1 })).toBe(false);
    expect(isDraftEmpty({ ...base, subject: "hi" })).toBe(false);
    expect(isDraftEmpty({ ...base, htmlTrimmed: "hello" })).toBe(false);
  });
});

// ---------------------------------------------------------- Close single-flight
// The composer's requestClose uses createSingleFlight so any concurrent
// attempt during the confirm dialog reuses the same in-flight Promise
// instead of opening a second dialog / firing onClose twice.
describe("close flow — single-flight semantics", () => {
  it("returns the SAME promise for concurrent requestClose calls", async () => {
    const sf = createSingleFlight<"closed" | "cancelled">();
    let resolveDialog!: (v: "closed" | "cancelled") => void;
    let dialogOpens = 0;
    const flow = () =>
      sf.run(async () => {
        dialogOpens++;
        return await new Promise<"closed" | "cancelled">((r) => {
          resolveDialog = r;
        });
      });
    const p1 = flow();
    const p2 = flow();
    const p3 = flow();
    expect(dialogOpens).toBe(1);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    resolveDialog("closed");
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect([r1, r2, r3]).toEqual(["closed", "closed", "closed"]);
  });

  it("cancel releases single-flight so a later attempt starts fresh", async () => {
    const sf = createSingleFlight<"closed" | "cancelled">();
    let resolveDialog!: (v: "closed" | "cancelled") => void;
    let opens = 0;
    const flow = () =>
      sf.run(async () => {
        opens++;
        return await new Promise<"closed" | "cancelled">((r) => {
          resolveDialog = r;
        });
      });
    const p1 = flow();
    resolveDialog("cancelled");
    await p1;
    // After the first flow settles the guard is empty — a new attempt runs.
    const p2 = flow();
    expect(opens).toBe(2);
    resolveDialog("closed");
    expect(await p2).toBe("closed");
  });

  it("save→close semantics: only saved_server/saved_local produce onClose", () => {
    type SaveResult = "saved_server" | "saved_local" | "failed" | "empty";
    const shouldClose = (r: SaveResult) => r === "saved_server" || r === "saved_local";
    expect(shouldClose("saved_server")).toBe(true);
    expect(shouldClose("saved_local")).toBe(true);
    expect(shouldClose("failed")).toBe(false);
    expect(shouldClose("empty")).toBe(false);
  });
});
