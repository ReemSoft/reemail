// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { DraftEngine } from "../mail-draft-engine";
import {
  clearDraftDoc,
  confirmDraftDocRemoteCommit,
  createDraftSaver,
  isCleanRemoteDraft,
  readDraftDoc,
  readDraftDocById,
  shouldCloseAfterUploadWait,
  writeDraftDoc,
  type DraftSnapshot,
  type DraftStorageLike,
  type SaveRemoteResult,
} from "../mail-draft-lifecycle";
import {
  mergeHydratedInlineImages,
  serializeInlineImages,
  type InlineComposeImage,
} from "../mail-compose-inline-images";
import { mutateEditorWithSingleInput } from "../mail-composer-autosave";
import { shouldReleaseAbandonedStagedResult } from "../mail-attachment-staging";
import { planRemoteDraftSave } from "../mail-draft-autosave-policy";
import {
  clearDraftTransportCache,
  readDraftTransportCache,
  writeDraftTransportCache,
} from "../mail-draft-transport-cache";

function storage(): DraftStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function snapshot(subject: string): DraftSnapshot {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject,
    html: `<p>${subject}</p>`,
    showCc: false,
    showBcc: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Draft recovery closure", () => {
  it("restores newer local Y over remote X as dirty and sync-eligible", () => {
    const store = storage();
    writeDraftDoc(store, "me@example.com", {
      version: 3,
      draftId: "draft-a",
      snapshot: snapshot("Y"),
      serverRef: { folderPath: "Drafts", uid: 10, uidValidity: "1" },
      updatedAt: 1,
      localRevision: 2,
      remoteCommittedRevision: 1,
      remoteCommitConfirmed: false,
      revisionId: "revision-y",
    });
    const recovered = readDraftDoc(store, "me@example.com")!;
    const engine = new DraftEngine();
    engine.restoreGenerations(recovered.localRevision!, recovered.remoteCommittedRevision!);
    engine.completeHydrationWhenReady();
    expect(recovered.snapshot.subject).toBe("Y");
    expect(engine.isDirty).toBe(true);
    expect(engine.canCommitLatest()).toBe(true);
  });

  it("restores an exactly confirmed Y clean", () => {
    const engine = new DraftEngine();
    engine.restoreGenerations(2, 2);
    engine.completeHydrationWhenReady();
    expect(engine.state).toBe("CLEAN");
    expect(engine.isDirty).toBe(false);
  });

  it("Draft B clear cannot remove Draft A recovery", () => {
    const store = storage();
    writeDraftDoc(store, "me@example.com", {
      version: 3,
      draftId: "draft-a",
      snapshot: snapshot("A"),
      serverRef: null,
      updatedAt: 1,
    });
    writeDraftDoc(
      store,
      "me@example.com",
      {
        version: 3,
        draftId: "draft-b",
        snapshot: snapshot("B"),
        serverRef: null,
        updatedAt: 2,
      },
      "edit",
    );
    clearDraftDoc(store, "me@example.com", "draft-b");
    expect(readDraftDocById(store, "me@example.com", "draft-a")?.snapshot.subject).toBe("A");
  });

  it("same-Draft Edit recovery stays dirty and stale confirmation cannot clean it", () => {
    const store = storage();
    writeDraftDoc(
      store,
      "me@example.com",
      {
        version: 3,
        draftId: "draft-edit",
        snapshot: snapshot("newer local"),
        serverRef: null,
        updatedAt: 1,
        recoveryKind: "edit",
        localRevision: 3,
        remoteCommittedRevision: 2,
        remoteCommitConfirmed: false,
        revisionId: "revision-3",
      },
      "edit",
    );
    expect(
      confirmDraftDocRemoteCommit(store, "me@example.com", "draft-edit", {
        localRevision: 2,
        revisionId: "revision-2",
        serverRef: null,
      }),
    ).toBe(false);
    expect(readDraftDocById(store, "me@example.com", "draft-edit")).toMatchObject({
      localRevision: 3,
      remoteCommittedRevision: 2,
      remoteCommitConfirmed: false,
    });
  });
});

describe("real editor and inline-image decisions", () => {
  it("one programmatic toolbar/extension mutation emits exactly one generation event", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "<p>before</p>";
    let generations = 0;
    editor.addEventListener("input", () => generations++);
    mutateEditorWithSingleInput(editor, () => {
      editor.innerHTML = "<p>after</p>";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(generations).toBe(1);
  });

  it("delayed hydration merges into current state and preserves a user image", () => {
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const image = (id: string) =>
      ({
        id,
        cid: `${id}@mailmaestro`,
        file,
        objectUrl: `blob:${id}`,
        mimeType: "image/png",
        filename: `${id}.png`,
        uploadFilename: `${id}.png`,
      }) as InlineComposeImage;
    expect(mergeHydratedInlineImages([image("user")], [image("remote")]).map((i) => i.id)).toEqual([
      "user",
      "remote",
    ]);
  });

  it("unresolved CID is preserved locally, omitted remotely, and blocks until explicit delete", () => {
    const html = '<p>x<img src="cid:missing@example" data-mm-source-cid="missing@example"></p>';
    expect(serializeInlineImages(html, [], { preserveUnresolvedCid: true }).html).toContain(
      "cid:missing@example",
    );
    expect(serializeInlineImages(html, []).html).not.toContain("missing@example");
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.registerResourceDependency("unresolved-restored-inline:missing@example");
    engine.failResourceDependency("unresolved-restored-inline:missing@example");
    expect(engine.beginSave()).toBe(false);
    engine.cancelResourceDependency("unresolved-restored-inline:missing@example");
    expect(engine.beginSave()).toBe(true);
  });

  it("normal and inline upload fences survive later typing and disappear on remove", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.registerResourceDependency("new-file:a");
    engine.registerResourceDependency("new-inline:b");
    engine.markUserEdit();
    expect(engine.userGeneration).toBe(2);
    expect(engine.beginSave()).toBe(false);
    engine.cancelResourceDependency("new-file:a");
    expect(engine.beginSave()).toBe(false);
    engine.resolveResourceDependency("new-inline:b");
    expect(engine.beginSave()).toBe(true);
  });
});

describe("save, close, discard, and upload results", () => {
  it("same-generation completed dedupe returns success and cannot strand Engine SAVING", async () => {
    const saver = createDraftSaver("draft", { saveRemote: async () => ({ ok: true }) });
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    expect(engine.beginSave()).toBe(true);
    const first = await saver.requestSave(snapshot("x"), null, 1);
    engine.markSaveFailed();
    expect(engine.beginSave()).toBe(true);
    const deduped = await saver.requestSave(snapshot("x"), null, 1);
    expect(deduped).toEqual(first);
    engine.markSaved(deduped.completedGeneration);
    expect(engine.state).toBe("CLEAN");
  });

  it("discard drains the first physical APPEND before remote delete", async () => {
    const gate = deferred<SaveRemoteResult>();
    const events: string[] = [];
    const saver = createDraftSaver("draft", {
      saveRemote: async () => {
        events.push("append-start");
        const result = await gate.promise;
        events.push("append-end");
        return result;
      },
    });
    const running = saver.requestSave(snapshot("x"), null, 1);
    await Promise.resolve();
    const discard = saver.cancelPendingAndAwaitRunning().then(() => events.push("delete-by-id"));
    gate.resolve({ ok: true, serverRef: { folderPath: "Drafts", uid: 7, uidValidity: "1" } });
    await Promise.all([running, discard]);
    expect(events).toEqual(["append-start", "append-end", "delete-by-id"]);
  });

  it("upload-wait close is cancelled by a later generation", () => {
    expect(
      shouldCloseAfterUploadWait({
        expectedGeneration: 4,
        currentGeneration: 5,
        saveSucceeded: true,
      }),
    ).toBe(false);
    expect(
      shouldCloseAfterUploadWait({
        expectedGeneration: 4,
        currentGeneration: 4,
        saveSucceeded: true,
      }),
    ).toBe(true);
  });

  it("clean existing Save-as-Draft is recognized without a remote request", () => {
    const saveRemote = vi.fn();
    expect(
      isCleanRemoteDraft({
        isDirty: false,
        hasRemoteDraft: true,
        serverRef: { folderPath: "Drafts", uid: 1, uidValidity: "1" },
        isEditMode: true,
      }),
    ).toBe(true);
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it("abandoned direct-upload results are released after delete/discard", () => {
    expect(
      shouldReleaseAbandonedStagedResult({
        resourceAbandoned: true,
        lifecycleFinalizing: false,
      }),
    ).toBe(true);
    expect(
      shouldReleaseAbandonedStagedResult({
        resourceAbandoned: false,
        lifecycleFinalizing: true,
      }),
    ).toBe(true);
  });
});

describe("remote backpressure and transport ownership", () => {
  it("35-second attachment APPEND produces bounded cooldown; explicit Save bypasses it", () => {
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: true,
        sending: false,
        now: 100_000,
        lastSuccessfulAutomaticSaveAt: 100_000,
        lastAutomaticSaveDurationMs: 35_000,
      }).delayMs,
    ).toBe(52_500);
    expect(
      planRemoteDraftSave({
        automatic: false,
        hasAttachments: true,
        sending: false,
        now: 100_000,
        lastSuccessfulAutomaticSaveAt: 100_000,
        lastAutomaticSaveDurationMs: 35_000,
      }).delayMs,
    ).toBe(0);
  });

  it("Draft-scoped transport handles survive close/reopen without validation network work", () => {
    const store = storage();
    writeDraftTransportCache(store, "me@example.com", "draft-a", {
      normal: [{ resourceId: "part-1", handle: "normal-handle" }],
      inline: [{ resourceId: "cid-a", handle: "inline-handle" }],
    });
    const reopened = readDraftTransportCache(store, "me@example.com", "draft-a");
    expect(reopened?.normal[0].handle).toBe("normal-handle");
    expect(reopened?.inline[0].handle).toBe("inline-handle");
    clearDraftTransportCache(store, "me@example.com", "draft-a");
    expect(readDraftTransportCache(store, "me@example.com", "draft-a")).toBeNull();
  });

  it("expired transport handles fall back locally without startup/provider requests", () => {
    const store = storage();
    writeDraftTransportCache(
      store,
      "me@example.com",
      "draft-a",
      {
        normal: [{ resourceId: "part-1", handle: "expired", expiresAt: 100 }],
        inline: [],
      },
      () => 0,
    );
    expect(
      readDraftTransportCache(store, "me@example.com", "draft-a", () => 1_000)?.normal,
    ).toEqual([]);
  });
});
