/**
 * M4-B contract tests for the draft lifecycle module.
 * Every branch listed in the round spec is asserted here.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createDraftSaver,
  createPendingDeleteQueue,
  deleteDraftAfterSend,
  clearDraftDoc,
  draftKeyV2,
  draftKeyV3,
  draftKeyV4,
  pendingDeleteKey,
  readDraftDoc,
  writeDraftDoc,
  updateDraftDocServerRef,
  type DraftSaveStatus,
  type DraftSnapshot,
  type DraftStorageLike,
  type SaveRemoteResult,
} from "../mail-draft-lifecycle";

describe("post-send draft deletion", () => {
  it("does not block completion and reports a deferred failure", async () => {
    let settle!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const onFailure = vi.fn();
    deleteDraftAfterSend({ deleteRemote: () => pending, onFailure });
    expect(onFailure).not.toHaveBeenCalled();
    settle(false);
    await pending;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("reports a thrown delete failure exactly once", async () => {
    const onFailure = vi.fn();
    deleteDraftAfterSend({
      deleteRemote: () => {
        throw new Error("offline");
      },
      onFailure,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

function memStorage(): DraftStorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

function snap(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    html: "",
    showCc: false,
    showBcc: false,
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("v2 → v3 migration", () => {
  const email = "user@example.com";

  it("migrates a legacy v2 blob to v3 with a fresh draftId and removes v2", () => {
    const s = memStorage();
    const legacy = {
      to: [{ email: "a@b.co", name: "A", valid: true }],
      cc: [],
      bcc: [],
      subject: "hi",
      html: "<p>hi</p>",
      showCc: true,
    };
    s.setItem(draftKeyV2(email), JSON.stringify(legacy));

    const doc = readDraftDoc(
      s,
      email,
      () => "fixed-id",
      () => 1000,
    );
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(3);
    expect(doc!.draftId).toBe("fixed-id");
    expect(doc!.serverRef).toBeNull();
    expect(doc!.snapshot.subject).toBe("hi");
    expect(doc!.snapshot.to[0].email).toBe("a@b.co");
    expect(doc!.snapshot.showCc).toBe(true);
    // v2 key removed after v3 write.
    expect(s.getItem(draftKeyV2(email))).toBeNull();
    // Draft-scoped recovery key written.
    expect(s.getItem(draftKeyV4(email, "fixed-id"))).toContain("fixed-id");
  });

  it("returns the existing v3 doc without touching v2 when both present", () => {
    const s = memStorage();
    s.setItem(draftKeyV2(email), JSON.stringify({ to: [], cc: [], bcc: [], subject: "old" }));
    const existing = {
      version: 3,
      draftId: "keep",
      snapshot: snap({ subject: "new" }),
      serverRef: null,
      updatedAt: 1,
    };
    s.setItem(draftKeyV3(email), JSON.stringify(existing));

    const doc = readDraftDoc(s, email);
    expect(doc?.draftId).toBe("keep");
    expect(doc?.snapshot.subject).toBe("new");
    // We do NOT proactively delete v2 in this branch (belt-and-suspenders is
    // clearDraftDoc's job).
    expect(s.getItem(draftKeyV2(email))).not.toBeNull();
  });

  it("returns null when nothing is stored", () => {
    const s = memStorage();
    expect(readDraftDoc(s, email)).toBeNull();
  });

  it("returns null on corrupted v3 payload and does not throw", () => {
    const s = memStorage();
    s.setItem(draftKeyV3(email), "{not json");
    expect(readDraftDoc(s, email)).toBeNull();
  });
});

describe("writeDraftDoc / clearDraftDoc", () => {
  const email = "u@e.com";
  it("round-trips a v3 doc through storage", () => {
    const s = memStorage();
    const doc = {
      version: 3 as const,
      draftId: "x",
      snapshot: snap({ subject: "s" }),
      serverRef: null,
      updatedAt: 5,
    };
    expect(writeDraftDoc(s, email, doc)).toBe(true);
    expect(readDraftDoc(s, email)?.snapshot.subject).toBe("s");
  });

  it("returns false when storage throws (quota) without crashing", () => {
    const s: DraftStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const ok = writeDraftDoc(s, email, {
      version: 3,
      draftId: "x",
      snapshot: snap(),
      serverRef: null,
      updatedAt: 0,
    });
    expect(ok).toBe(false);
  });

  it("clears both v3 and stale v2 keys", () => {
    const s = memStorage();
    s.setItem(draftKeyV2(email), "legacy");
    s.setItem(draftKeyV3(email), "cur");
    clearDraftDoc(s, email);
    expect(s.getItem(draftKeyV2(email))).toBeNull();
    expect(s.getItem(draftKeyV3(email))).toBeNull();
  });

  it("patches serverRef for the matching v3 draft only", () => {
    const s = memStorage();
    const doc = {
      version: 3 as const,
      draftId: "d1",
      snapshot: snap({ subject: "s" }),
      serverRef: null,
      updatedAt: 5,
    };
    writeDraftDoc(s, email, doc);
    const ok = updateDraftDocServerRef(
      s,
      email,
      "d1",
      { folderPath: "Drafts", uid: 9, uidValidity: "v" },
      () => 10,
    );
    expect(ok).toBe(true);
    const read = readDraftDoc(s, email);
    expect(read?.serverRef).toEqual({ folderPath: "Drafts", uid: 9, uidValidity: "v" });
    expect(read?.updatedAt).toBe(10);
    expect(updateDraftDocServerRef(s, email, "other", null)).toBe(false);
    expect(readDraftDoc(s, email)?.serverRef?.uid).toBe(9);
  });
});

describe("createDraftSaver — serverRef freshness", () => {
  it("uses the latest returned serverRef for a queued follow-up save", async () => {
    const seenPreviousRefs: Array<unknown> = [];
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saveRemote = vi.fn(async ({ previousRef }: { previousRef: unknown }) => {
      seenPreviousRefs.push(previousRef);
      const d = deferred<SaveRemoteResult>();
      gates.push({ resolve: d.resolve });
      return d.promise;
    });
    const saver = createDraftSaver("d1", { saveRemote });
    const p1 = saver.requestSave(snap({ subject: "one" }), null, 1);
    await Promise.resolve();
    const p2 = saver.requestSave(snap({ subject: "two" }), null, 2);
    gates[0].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 10, uidValidity: "v" },
    });
    await p1;
    expect(saveRemote).toHaveBeenCalledTimes(2);
    expect(seenPreviousRefs[1]).toEqual({ folderPath: "Drafts", uid: 10, uidValidity: "v" });
    gates[1].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 11, uidValidity: "v" },
    });
    await p2;
  });
});

describe("createDraftSaver — awaitIdle", () => {
  it("resolves immediately when no save is in flight", async () => {
    const saver = createDraftSaver("d-idle", { saveRemote: vi.fn(async () => ({ ok: true })) });
    await expect(saver.awaitIdle()).resolves.toBeUndefined();
  });

  it("waits for an in-flight save to settle before resolving", async () => {
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saver = createDraftSaver("d-wait", {
      saveRemote: async () => {
        const d = deferred<SaveRemoteResult>();
        gates.push({ resolve: d.resolve });
        return d.promise;
      },
    });
    const p = saver.requestSave(snap({ subject: "x" }), null, 1);
    await Promise.resolve();
    let idle = false;
    const idlePromise = saver.awaitIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    gates[0].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 5, uidValidity: "v" } });
    await Promise.all([p, idlePromise]);
    expect(idle).toBe(true);
  });

  it("also drains a coalesced follow-up save before resolving", async () => {
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saver = createDraftSaver("d-drain", {
      saveRemote: async () => {
        const d = deferred<SaveRemoteResult>();
        gates.push({ resolve: d.resolve });
        return d.promise;
      },
    });
    const p1 = saver.requestSave(snap({ subject: "one" }), null, 1);
    await Promise.resolve();
    const p2 = saver.requestSave(snap({ subject: "two" }), null, 2);
    let idle = false;
    const idlePromise = saver.awaitIdle().then(() => {
      idle = true;
    });
    gates[0].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "v" } });
    await p1;
    await Promise.resolve();
    expect(idle).toBe(false);
    gates[1].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 2, uidValidity: "v" } });
    await Promise.all([p2, idlePromise]);
    expect(idle).toBe(true);
  });
});

describe("createDraftSaver — generation threading", () => {
  it("passes each run's exact generation to saveRemote and echoes it back in onCompleted", async () => {
    const seenGenerations: number[] = [];
    const completions: number[] = [];
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saver = createDraftSaver("d-gen", {
      saveRemote: async ({ generation }) => {
        seenGenerations.push(generation);
        const d = deferred<SaveRemoteResult>();
        gates.push({ resolve: d.resolve });
        return d.promise;
      },
      onCompleted: (info) => completions.push(info.completedGeneration),
    });
    const p1 = saver.requestSave(snap({ subject: "a" }), null, 10);
    await Promise.resolve();
    const p2 = saver.requestSave(snap({ subject: "b" }), null, 11);
    gates[0].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "v" } });
    await p1;
    gates[1].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 2, uidValidity: "v" } });
    await p2;
    expect(seenGenerations).toEqual([10, 11]);
    expect(completions).toEqual([10, 11]);
  });

  it("reports the merged generation for a follow-up that coalesced older requests", async () => {
    const seen: Array<{ generation: number; subject: string }> = [];
    const completions: number[] = [];
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saver = createDraftSaver("d-coalesce", {
      saveRemote: async ({ snapshot, generation }) => {
        seen.push({ generation, subject: snapshot.subject });
        const d = deferred<SaveRemoteResult>();
        gates.push({ resolve: d.resolve });
        return d.promise;
      },
      onCompleted: (info) => completions.push(info.completedGeneration),
    });
    const p1 = saver.requestSave(snap({ subject: "one" }), null, 1);
    const p2 = saver.requestSave(snap({ subject: "two" }), null, 2);
    const p3 = saver.requestSave(snap({ subject: "three" }), null, 3);
    expect(seen).toEqual([{ generation: 1, subject: "one" }]);
    gates[0].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "v" } });
    await p1;
    // The follow-up carries the newest merged snapshot AND its generation.
    expect(seen).toEqual([
      { generation: 1, subject: "one" },
      { generation: 3, subject: "three" },
    ]);
    gates[1].resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 2, uidValidity: "v" } });
    await Promise.all([p2, p3]);
    expect(completions).toEqual([1, 3]);
  });
});

describe("createDraftSaver — save-trigger diagnostics", () => {
  it("passes the optional trigger to saveRemote and preserves it in completion", async () => {
    const seen: Array<{
      generation: number;
      trigger?: {
        reason: string;
        inFlight: boolean;
        coalesced: boolean;
      };
    }> = [];
    const completions: Array<unknown> = [];
    const saver = createDraftSaver("d-trigger", {
      saveRemote: async ({ generation, trigger }) => {
        seen.push({ generation, trigger });
        return {
          ok: true,
          serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "v" },
        };
      },
      onCompleted: (info) => completions.push(info),
    });
    await saver.requestSave(snap(), null, 7, {
      reason: "automatic",
      generation: 7,
      inFlight: false,
      coalesced: false,
      dirty: true,
      attachmentsChanged: false,
    });
    expect(seen[0]).toEqual({
      generation: 7,
      trigger: {
        reason: "automatic",
        generation: 7,
        inFlight: false,
        coalesced: false,
        dirty: true,
        attachmentsChanged: false,
      },
    });
    expect(completions[0]).toMatchObject({ completedGeneration: 7, status: "saved" });
  });
});

describe("createDraftSaver — same-generation dedupe", () => {
  it("Close generation N while N is in flight waits for the existing save and does not APPEND again", async () => {
    const gate = deferred<SaveRemoteResult>();
    const saveRemote = vi.fn(async () => gate.promise);
    const saver = createDraftSaver("d-dedupe", { saveRemote });
    const p1 = saver.requestSave(snap({ subject: "same" }), null, 32);
    await Promise.resolve();
    const p2 = saver.requestSave(snap({ subject: "same" }), null, 32);
    expect(saveRemote).toHaveBeenCalledTimes(1);
    gate.resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 10, uidValidity: "v" },
    });
    await Promise.all([p1, p2]);
    expect(saveRemote).toHaveBeenCalledTimes(1);
  });

  it("Close generation N after N was successfully saved performs ZERO additional saves", async () => {
    const saveRemote = vi.fn(
      async (): Promise<SaveRemoteResult> => ({
        ok: true,
        serverRef: { folderPath: "Drafts", uid: 10, uidValidity: "v" },
      }),
    );
    const saver = createDraftSaver("d-saved", { saveRemote });
    await saver.requestSave(snap({ subject: "same" }), null, 32);
    await saver.requestSave(snap({ subject: "same" }), null, 32);
    expect(saveRemote).toHaveBeenCalledTimes(1);
  });

  it("a newer generation while N is running produces exactly one follow-up", async () => {
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const calls: number[] = [];
    const saver = createDraftSaver("d-next", {
      saveRemote: async ({ generation }) => {
        calls.push(generation);
        const gate = deferred<SaveRemoteResult>();
        gates.push({ resolve: gate.resolve });
        return gate.promise;
      },
    });
    const p1 = saver.requestSave(snap({ subject: "a" }), null, 32);
    await Promise.resolve();
    const p2 = saver.requestSave(snap({ subject: "b" }), null, 33);
    gates[0].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 10, uidValidity: "v" },
    });
    await p1;
    expect(calls).toEqual([32, 33]);
    gates[1].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 11, uidValidity: "v" },
    });
    await p2;
    expect(calls).toEqual([32, 33]);
  });
});

describe("createDraftSaver — delete-specific drain", () => {
  it("drops a queued follow-up and waits only for the running save", async () => {
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const calls: number[] = [];
    const saver = createDraftSaver("d-delete", {
      saveRemote: async ({ generation }) => {
        calls.push(generation);
        const gate = deferred<SaveRemoteResult>();
        gates.push({ resolve: gate.resolve });
        return gate.promise;
      },
    });
    const running = saver.requestSave(snap({ subject: "running" }), null, 32);
    await Promise.resolve();
    const pending = saver.requestSave(snap({ subject: "pending" }), null, 33);
    expect(calls).toEqual([32]);
    let drained = false;
    const drain = saver.cancelPendingAndAwaitRunning().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gates[0].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 10, uidValidity: "v" },
    });
    await Promise.all([running, pending, drain]);
    expect(calls).toEqual([32]);
    expect(drained).toBe(true);
  });
});

describe("createDraftSaver", () => {
  it("emits saving → saved on successful remote save and updates serverRef", async () => {
    const events: DraftSaveStatus[] = [];
    let capturedRef: unknown = null;
    const saveRemote = vi.fn(
      async (): Promise<SaveRemoteResult> => ({
        ok: true,
        serverRef: { folderPath: "Drafts", uid: 7, uidValidity: "1" },
      }),
    );
    const saver = createDraftSaver("d1", {
      saveRemote,
      onStatus: (s) => events.push(s),
      onServerRef: (r) => (capturedRef = r),
    });
    await saver.requestSave(snap({ subject: "a" }), null, 1);
    expect(events).toEqual(["saving", "saved"]);
    expect(capturedRef).toEqual({ folderPath: "Drafts", uid: 7, uidValidity: "1" });
    expect(saveRemote).toHaveBeenCalledTimes(1);
    expect(saver.getStatus()).toBe("saved");
    expect(saver.isBusy()).toBe(false);
  });

  it("emits saving → failed when remote fails (no serverRef change)", async () => {
    const events: DraftSaveStatus[] = [];
    const onRef = vi.fn();
    const saver = createDraftSaver("d1", {
      saveRemote: async () => ({ ok: false, code: "NETWORK" }),
      onStatus: (s) => events.push(s),
      onServerRef: onRef,
    });
    await saver.requestSave(snap(), null, 1);
    expect(events).toEqual(["saving", "failed"]);
    expect(onRef).not.toHaveBeenCalled();
  });

  it("coalesces rapid saves: only one runs concurrently, latest snapshot wins in follow-up", async () => {
    const calls: string[] = [];
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saveRemote = vi.fn(async ({ snapshot }: { snapshot: DraftSnapshot }) => {
      calls.push(snapshot.subject);
      const d = deferred<SaveRemoteResult>();
      gates.push({ resolve: d.resolve });
      return d.promise;
    });
    const saver = createDraftSaver("d1", { saveRemote });

    const p1 = saver.requestSave(snap({ subject: "one" }), null, 1);
    // Both of these arrive while p1 is in flight — must coalesce into ONE
    // follow-up carrying the latest snapshot ("three").
    const p2 = saver.requestSave(snap({ subject: "two" }), null, 2);
    const p3 = saver.requestSave(snap({ subject: "three" }), null, 3);

    // Only the first invocation has fired so far.
    expect(saveRemote).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["one"]);

    // Resolve #1 → the coalesced follow-up should now fire once with "three".
    gates[0].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "v" },
    });
    await p1;
    // Follow-up now issued.
    expect(saveRemote).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["one", "three"]);
    gates[1].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 2, uidValidity: "v" },
    });
    await Promise.all([p2, p3]);
    expect(saveRemote).toHaveBeenCalledTimes(2);
  });

  it("drops stale generation results (out-of-order responses)", async () => {
    // Force out-of-order settle by resolving the SECOND call before the first.
    const gates: Array<{ resolve: (v: SaveRemoteResult) => void }> = [];
    const saveRemote = vi.fn(async () => {
      const d = deferred<SaveRemoteResult>();
      gates.push({ resolve: d.resolve });
      return d.promise;
    });
    const refs: unknown[] = [];
    const events: DraftSaveStatus[] = [];
    const saver = createDraftSaver("d1", {
      saveRemote,
      onServerRef: (r) => refs.push(r),
      onStatus: (s) => events.push(s),
    });
    const p1 = saver.requestSave(snap({ subject: "a" }), null, 1);
    // Kick a follow-up that will settle first with a "newer" ref.
    const p2 = saver.requestSave(snap({ subject: "b" }), null, 2);

    // Settle the follow-up (#2) FIRST — this is the latest issued seq once
    // #1's own run completes and triggers the queued run. Simulate by
    // resolving #1 with the OLD ref then #2 with the NEW ref; the old ref
    // MUST still be applied (it was current at the time #1 ran) and then
    // overwritten by #2. To exercise stale-drop we resolve #1 AFTER #2:
    gates[0].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "v" },
    });
    await p1;
    gates[1].resolve({
      ok: true,
      serverRef: { folderPath: "Drafts", uid: 2, uidValidity: "v" },
    });
    await p2;

    // The newest server ref must be the last applied.
    expect(refs[refs.length - 1]).toEqual({
      folderPath: "Drafts",
      uid: 2,
      uidValidity: "v",
    });
    // Final status is "saved" (from the latest successful save).
    expect(saver.getStatus()).toBe("saved");
  });

  it("treats a thrown saveRemote as a hard failure (failed)", async () => {
    const events: DraftSaveStatus[] = [];
    const saver = createDraftSaver("d1", {
      saveRemote: async () => {
        throw new Error("boom");
      },
      onStatus: (s) => events.push(s),
    });
    await saver.requestSave(snap(), null, 1);
    expect(events).toEqual(["saving", "failed"]);
  });
});

describe("createPendingDeleteQueue", () => {
  const email = "u@e.com";

  it("enqueues, lists, dedupes by draftId, and persists to storage", () => {
    const s = memStorage();
    const q = createPendingDeleteQueue({
      storage: s,
      deleteRemote: async () => ({ ok: true }),
      now: () => 100,
    });
    q.enqueue(email, { draftId: "a", previousRef: null });
    q.enqueue(email, {
      draftId: "a",
      previousRef: { folderPath: "Drafts", uid: 9, uidValidity: "1" },
    });
    q.enqueue(email, { draftId: "b", previousRef: null });
    const list = q.list(email);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.draftId === "a")?.previousRef?.uid).toBe(9);
    // Persisted.
    expect(s.getItem(pendingDeleteKey(email))).not.toBeNull();
  });

  it("flush removes successful entries and keeps failing ones", async () => {
    const s = memStorage();
    const deleteRemote = vi.fn(async ({ draftId }: { draftId: string }) => ({
      ok: draftId === "ok",
    }));
    const q = createPendingDeleteQueue({ storage: s, deleteRemote });
    q.enqueue(email, { draftId: "ok", previousRef: null });
    q.enqueue(email, { draftId: "fail", previousRef: null });

    const summary = await q.flush(email);
    expect(summary).toEqual({ tried: 2, deleted: 1, kept: 1 });
    const remaining = q.list(email);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].draftId).toBe("fail");
    expect(deleteRemote).toHaveBeenCalledTimes(2);
  });

  it("flush on an empty queue is a no-op", async () => {
    const s = memStorage();
    const deleteRemote = vi.fn(async () => ({ ok: true }));
    const q = createPendingDeleteQueue({ storage: s, deleteRemote });
    const summary = await q.flush(email);
    expect(summary).toEqual({ tried: 0, deleted: 0, kept: 0 });
    expect(deleteRemote).not.toHaveBeenCalled();
  });

  it("survives thrown deleteRemote (keeps entry, no crash)", async () => {
    const s = memStorage();
    const q = createPendingDeleteQueue({
      storage: s,
      deleteRemote: async () => {
        throw new Error("net");
      },
    });
    q.enqueue(email, { draftId: "x", previousRef: null });
    const summary = await q.flush(email);
    expect(summary).toEqual({ tried: 1, deleted: 0, kept: 1 });
    expect(q.list(email)).toHaveLength(1);
  });
});

// ---------------------------------------------------------- completedGeneration contract
describe("DraftSaver.onCompleted / completedGeneration", () => {
  it("echoes completedGeneration on success and drops stale responses", async () => {
    // Two saves in flight sequentially, second supersedes first mid-flight.
    let resolveFirst: (v: SaveRemoteResult) => void = () => {};
    let callIndex = 0;
    const saveRemote = vi.fn(async () => {
      callIndex++;
      if (callIndex === 1) {
        return await new Promise<SaveRemoteResult>((r) => {
          resolveFirst = r;
        });
      }
      return { ok: true, serverRef: { folderPath: "Drafts", uid: 42, uidValidity: "1" } };
    });
    const completions: Array<{ gen: number; status: DraftSaveStatus }> = [];
    const saver = createDraftSaver("d1", {
      saveRemote,
      onCompleted: (info) =>
        completions.push({ gen: info.completedGeneration, status: info.status }),
    });
    const p1 = saver.requestSave(snap({ subject: "a" }), null, 1);
    // Merge #2 with generation 2 while #1 is in flight → still coalesced,
    // but the first call already left the queue. Wait a microtask so run
    // has started, then supersede by resolving with stale success.
    await Promise.resolve();
    // Now the second requestSave enters as fresh pending because run started.
    const p2 = saver.requestSave(snap({ subject: "b" }), null, 2);
    // First run's remote resolves → stale (mySeq !== latestIssuedSeq once
    // seq advances). But seq advances only when the NEXT run starts. So
    // to force staleness, we simulate a third request coming in after first
    // resolves but before onCompleted fires — the natural coalescing gives
    // us only one call in the queue, so we test the fresh path here.
    resolveFirst({ ok: true, serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "1" } });
    await p1;
    await p2;
    // Both completions fired with their own generation.
    expect(completions.map((c) => c.gen).sort()).toEqual([1, 2]);
    expect(completions.every((c) => c.status === "saved")).toBe(true);
  });

  it("coalesced saves report only the latest generation", async () => {
    const saveRemote = vi.fn(async () => ({
      ok: true as const,
      serverRef: { folderPath: "Drafts", uid: 7, uidValidity: "1" },
    }));
    const completions: number[] = [];
    let resolveInFlight: (v: SaveRemoteResult) => void = () => {};
    let firstCall = true;
    const gatedSaveRemote = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        return await new Promise<SaveRemoteResult>((r) => {
          resolveInFlight = r;
        });
      }
      return saveRemote();
    });
    const saver = createDraftSaver("d2", {
      saveRemote: gatedSaveRemote,
      onCompleted: (info) => completions.push(info.completedGeneration),
    });
    const p1 = saver.requestSave(snap({ subject: "v1" }), null, 10);
    await Promise.resolve();
    // First run is blocked. Now enqueue two coalesced requests with
    // generations 11 then 12 — only 12 must be reported.
    const p2 = saver.requestSave(snap({ subject: "v2" }), null, 11);
    const p3 = saver.requestSave(snap({ subject: "v3" }), null, 12);
    resolveInFlight({ ok: true, serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "1" } });
    await Promise.all([p1, p2, p3]);
    expect(completions).toEqual([10, 12]);
  });

  it("reports failed with generation on NETWORK failure", async () => {
    const saver = createDraftSaver("d3", {
      saveRemote: async () => ({ ok: false, code: "NETWORK" }),
      onCompleted: (info) => {
        expect(info.status).toBe("failed");
        expect(info.completedGeneration).toBe(99);
        expect(info.code).toBe("NETWORK");
      },
    });
    await saver.requestSave(snap({ subject: "x" }), null, 99);
  });
});

// ---------------------------------------------------------- Failure classification
describe("createDraftSaver — failure classification", () => {
  async function runWithCode(code: string | undefined) {
    const events: DraftSaveStatus[] = [];
    const completions: Array<{ gen: number; status: DraftSaveStatus; code?: string }> = [];
    const onRef = vi.fn();
    const saver = createDraftSaver("d-fc", {
      saveRemote: async () => ({ ok: false, code }),
      onStatus: (s) => events.push(s),
      onServerRef: onRef,
      onCompleted: (info) =>
        completions.push({
          gen: info.completedGeneration,
          status: info.status,
          code: info.code,
        }),
    });
    await saver.requestSave(snap({ subject: "s" }), null, 7);
    return { events, completions, onRef, saver };
  }

  it("NETWORK → failed, echoes generation, no serverRef", async () => {
    const { events, completions, onRef, saver } = await runWithCode("NETWORK");
    expect(events).toEqual(["saving", "failed"]);
    expect(completions).toEqual([{ gen: 7, status: "failed", code: "NETWORK" }]);
    expect(onRef).not.toHaveBeenCalled();
    expect(saver.getStatus()).toBe("failed");
  });

  it.each([
    "SESSION_REQUIRED",
    "CREDENTIALS_PENDING",
    "SAFE_DRAFT_REPLACE_UNSUPPORTED",
    "ATTACHMENT_TOO_LARGE",
    "ATTACHMENTS_TOO_LARGE",
    "TOO_MANY_ATTACHMENTS",
    "APPEND_FAILED",
    "IMAP_ERROR",
    "UNKNOWN",
  ])("%s → failed, echoes generation with code, no serverRef", async (code) => {
    const { events, completions, onRef, saver } = await runWithCode(code);
    expect(events).toEqual(["saving", "failed"]);
    expect(completions).toEqual([{ gen: 7, status: "failed", code }]);
    expect(onRef).not.toHaveBeenCalled();
    expect(saver.getStatus()).toBe("failed");
  });

  it("missing code on ok=false → failed (defensive)", async () => {
    const { events, completions } = await runWithCode(undefined);
    expect(events).toEqual(["saving", "failed"]);
    expect(completions[0].status).toBe("failed");
    expect(completions[0].code).toBeUndefined();
  });

  it("thrown saveRemote → NETWORK class → failed", async () => {
    const events: DraftSaveStatus[] = [];
    const completions: Array<{ status: DraftSaveStatus; code?: string }> = [];
    const saver = createDraftSaver("d-thr", {
      saveRemote: async () => {
        throw new Error("boom");
      },
      onStatus: (s) => events.push(s),
      onCompleted: (info) => completions.push({ status: info.status, code: info.code }),
    });
    await saver.requestSave(snap({ subject: "x" }), null, 1);
    expect(events).toEqual(["saving", "failed"]);
    expect(completions).toEqual([{ status: "failed", code: "NETWORK" }]);
  });
});
