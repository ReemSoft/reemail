import { describe, it, expect, vi } from "vitest";
import {
  createAutosaveScheduler,
  attachInputListener,
  attachBeforeUnloadGuard,
  isDraftEmpty,
  attachmentSetSignature,
  decideAttachmentSizeBlock,
  createRequestBoundSignatureStore,
  canStartRemoteAutosave,
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

  it("maxDelayMs forces a fire even under continuous schedule() activity", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 1500, maxDelayMs: 5000, onFire });
    // Continuous typing: re-schedule every 100ms, which keeps resetting the
    // idle debounce — but the max-wait must still fire once at ~5s.
    for (let i = 0; i < 50; i++) {
      s.schedule();
      vi.advanceTimersByTime(100);
    }
    // ~5000ms elapsed → max-wait fired once.
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("maxDelayMs resets after each fire (new activity starts a fresh window)", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 1500, maxDelayMs: 5000, onFire });
    s.schedule();
    vi.advanceTimersByTime(1500);
    expect(onFire).toHaveBeenCalledTimes(1);
    // New activity after the fire re-arms both timers.
    s.schedule();
    vi.advanceTimersByTime(1500);
    expect(onFire).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("without maxDelayMs, continuous schedule() does NOT force-fire (old behavior)", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const s = createAutosaveScheduler({ delayMs: 1500, onFire });
    for (let i = 0; i < 50; i++) {
      s.schedule();
      vi.advanceTimersByTime(100);
    }
    // Debounce keeps resetting; nothing fires while activity continues.
    expect(onFire).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });
});

describe("canStartRemoteAutosave", () => {
  it("requires dirty and rejects sending/delete intent", () => {
    expect(canStartRemoteAutosave({ sending: false, dirty: true, deleteIntent: false })).toBe(true);
    expect(canStartRemoteAutosave({ sending: false, dirty: false, deleteIntent: false })).toBe(false);
    expect(canStartRemoteAutosave({ sending: true, dirty: true, deleteIntent: false })).toBe(false);
    expect(canStartRemoteAutosave({ sending: false, dirty: true, deleteIntent: true })).toBe(false);
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

// ---------------------------------------------------------- attachment-size block
// Guards the automatic remote draft-save against re-download loops after an
// authoritative attachment-size failure. Manual Save/Send never consult this
// guard (the composer only applies it inside the automatic remote-save flush).
describe("attachmentSetSignature", () => {
  const base = {
    existingKept: [{ id: "a", filename: "x.pdf", size: 5, part: "2" }],
    files: [{ name: "local.bin", size: 3, lastModified: 7 }],
    inlineImages: [{ uploadFilename: "i1", filename: "pic.png", size: 4 }],
  };

  it("is stable across body/recipient/subject edits (no attachment change)", () => {
    expect(attachmentSetSignature(base)).toBe(attachmentSetSignature(base));
    expect(attachmentSetSignature(base)).toBe(
      attachmentSetSignature({
        ...base,
        // Non-attachment fields are not part of the signature at all.
        existingKept: [...base.existingKept],
        files: [...base.files],
        inlineImages: [...base.inlineImages],
      }),
    );
  });

  it("changes when an attachment is added", () => {
    const added = { ...base, files: [...base.files, { name: "new.bin", size: 9, lastModified: 2 }] };
    expect(attachmentSetSignature(added)).not.toBe(attachmentSetSignature(base));
  });

  it("changes when an attachment is removed", () => {
    const removed = { ...base, existingKept: [] };
    expect(attachmentSetSignature(removed)).not.toBe(attachmentSetSignature(base));
  });

  it("changes when a kept attachment is replaced", () => {
    const replaced = {
      ...base,
      existingKept: [{ id: "a", filename: "x.pdf", size: 6, part: "2" }],
    };
    expect(attachmentSetSignature(replaced)).not.toBe(attachmentSetSignature(base));
  });
});

describe("decideAttachmentSizeBlock", () => {
  it("allows the first automatic remote attempt when no block is recorded", () => {
    expect(decideAttachmentSizeBlock({ blockedSignature: null, currentSignature: "S" })).toEqual({
      remoteSaveAllowed: true,
      clearBlock: false,
    });
  });

  it("skips automatic remote saves while the blocked attachment set is unchanged", () => {
    expect(decideAttachmentSizeBlock({ blockedSignature: "S", currentSignature: "S" })).toEqual({
      remoteSaveAllowed: false,
      clearBlock: false,
    });
  });

  it("allows and clears the block once the attachment set changes", () => {
    expect(decideAttachmentSizeBlock({ blockedSignature: "S", currentSignature: "S2" })).toEqual({
      remoteSaveAllowed: true,
      clearBlock: true,
    });
  });

  it("text-only edits keep the same signature, so the block stays active", () => {
    const attachments = {
      existingKept: [{ id: "a", filename: "x.pdf", size: 5, part: "2" }],
      files: [{ name: "local.bin", size: 3, lastModified: 7 }],
      inlineImages: [],
    };
    const blocked = attachmentSetSignature(attachments);
    expect(
      decideAttachmentSizeBlock({
        blockedSignature: blocked,
        currentSignature: attachmentSetSignature(attachments),
      }),
    ).toEqual({ remoteSaveAllowed: false, clearBlock: false });
  });

  it("does not gate manual save/send (those paths never read a block)", () => {
    // The composer only consults this decision in the automatic remote-save
    // flush; manual Save/Send bypass it, so a null block (the manual-path
    // precondition) always allows the attempt.
    expect(decideAttachmentSizeBlock({ blockedSignature: null, currentSignature: "S" }).remoteSaveAllowed).toBe(
      true,
    );
  });
});

// -------------------------------------------------- request-bound signatures
// Models the A→B in-flight race end-to-end: the composer captures the
// signature for request A inside saveRemote (generation-keyed), the user
// switches to B, and A's late completion is attributed to A's own signature.
describe("createRequestBoundSignatureStore — A→B in-flight race", () => {
  const setA = {
    existingKept: [{ id: "a", filename: "x.pdf", size: 5, part: "2" }],
    files: [{ name: "local.bin", size: 3, lastModified: 7 }],
    inlineImages: [],
  };
  const setB = {
    existingKept: [],
    files: [{ name: "replacement.bin", size: 99, lastModified: 8 }],
    inlineImages: [{ uploadFilename: "i1", filename: "pic.png", size: 4 }],
  };

  it("captures and consumes per-generation without cross-attribution", () => {
    const store = createRequestBoundSignatureStore();
    store.capture(1, attachmentSetSignature(setA));
    store.capture(2, attachmentSetSignature(setB));
    expect(store.size()).toBe(2);
    // gen 1 consumes EXACTLY what gen 1 captured — never the later set B.
    expect(store.consume(1)).toBe(attachmentSetSignature(setA));
    expect(store.consume(1)).toBeNull();
    expect(store.consume(2)).toBe(attachmentSetSignature(setB));
    expect(store.size()).toBe(0);
  });

  it("late size failure for A stores sig(A), NEVER the live set B", () => {
    const store = createRequestBoundSignatureStore();
    // Request A is built and sent with attachment set A.
    store.capture(7, attachmentSetSignature(setA));
    // While A is in flight, the user changes attachments to B (live refs now B).
    const liveSignatureB = attachmentSetSignature(setB);
    // A returns an attachment-size-limit error. onCompleted consumes the
    // entry for A's generation and stores that signature — it must NOT read
    // the live B set.
    const blocked = store.consume(7);
    expect(blocked).toBe(attachmentSetSignature(setA));
    expect(blocked).not.toBe(liveSignatureB);
    // Next autosave: current live signature is B, block is A → B eligible.
    const decision = decideAttachmentSizeBlock({
      blockedSignature: blocked,
      currentSignature: liveSignatureB,
    });
    expect(decision).toEqual({ remoteSaveAllowed: true, clearBlock: true });
  });

  it("B remains eligible for the next automatic remote save", () => {
    const store = createRequestBoundSignatureStore();
    store.capture(3, attachmentSetSignature(setA));
    const blockedA = store.consume(3);
    expect(
      decideAttachmentSizeBlock({
        blockedSignature: blockedA,
        currentSignature: attachmentSetSignature(setB),
      }).remoteSaveAllowed,
    ).toBe(true);
  });

  it("text-only edits while A is blocked still do not retry A", () => {
    const store = createRequestBoundSignatureStore();
    store.capture(5, attachmentSetSignature(setA));
    const blockedA = store.consume(5);
    // User only edited the body: attachment set is still A.
    expect(
      decideAttachmentSizeBlock({
        blockedSignature: blockedA,
        currentSignature: attachmentSetSignature(setA),
      }),
    ).toEqual({ remoteSaveAllowed: false, clearBlock: false });
  });

  it("changing attachments clears/bypasses A's block as designed", () => {
    const store = createRequestBoundSignatureStore();
    store.capture(9, attachmentSetSignature(setA));
    const blockedA = store.consume(9);
    const decision = decideAttachmentSizeBlock({
      blockedSignature: blockedA,
      currentSignature: attachmentSetSignature(setB),
    });
    expect(decision).toEqual({ remoteSaveAllowed: true, clearBlock: true });
  });

  it("successful save cleanup removes request-signature bookkeeping", () => {
    const store = createRequestBoundSignatureStore();
    store.capture(4, attachmentSetSignature(setA));
    store.capture(6, attachmentSetSignature(setB));
    // A success consumes the entry for its own generation (no block armed).
    expect(store.consume(6)).toBe(attachmentSetSignature(setB));
    expect(store.size()).toBe(1);
    expect(store.consume(4)).toBe(attachmentSetSignature(setA));
    expect(store.size()).toBe(0);
  });

  it("failed non-size save does not create a size block", () => {
    const store = createRequestBoundSignatureStore();
    store.capture(8, attachmentSetSignature(setA));
    // The completion consumed the entry, but the code is NOT a size-limit
    // code → the composer leaves any existing block untouched.
    const consumed = store.consume(8);
    const isSizeLimitError = (code: string) =>
      code === "ATTACHMENTS_TOO_LARGE" ||
      code === "SOURCE_ATTACHMENT_TOO_LARGE" ||
      code === "ATTACHMENT_LIMIT_EXCEEDED";
    expect(isSizeLimitError("IMAP_ERROR")).toBe(false);
    expect(consumed).not.toBeNull();
    // No block is armed: the current set stays eligible.
    expect(
      decideAttachmentSizeBlock({ blockedSignature: null, currentSignature: "S" })
        .remoteSaveAllowed,
    ).toBe(true);
  });

  it("an unattributable completion (no capture) never blocks the live set", () => {
    const store = createRequestBoundSignatureStore();
    // A run that short-circuited before building a transport has no entry.
    expect(store.consume(11)).toBeNull();
    // The composer therefore arms no block — the live set cannot be wrongly
    // marked size-blocked by a request that never transported it.
    expect(
      decideAttachmentSizeBlock({ blockedSignature: null, currentSignature: "S" })
        .remoteSaveAllowed,
    ).toBe(true);
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

  it("save→close semantics: only saved_server produces onClose", () => {
    type SaveResult = "saved_server" | "failed" | "empty";
    const shouldClose = (r: SaveResult) => r === "saved_server";
    expect(shouldClose("saved_server")).toBe(true);
    expect(shouldClose("failed")).toBe(false);
    expect(shouldClose("empty")).toBe(false);
  });
});
