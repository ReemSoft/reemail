// New-Message resurrection bug (MAILMAESTRO_CLEAN_CLOSE) — regression guards.
//
// After a successful remote Draft save + clean close, the v3 crash-recovery
// local Draft document must be cleared so the next "New Message" opens a blank
// composer. Crash safety is preserved: a dirty/failed/cancelled/crashed close
// or a local-only unsaved draft never clears the recovery doc.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  shouldFinalizeCleanClose,
  readDraftDoc,
  writeDraftDoc,
  clearDraftDoc,
  type DraftServerRef,
} from "../mail-draft-lifecycle";

const route = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

const serverRef: DraftServerRef = { folderPath: "[Gmail]/Drafts", uid: 42, uidValidity: "1" };

describe("shouldFinalizeCleanClose", () => {
  it("confirmed saved_server close always finalizes", () => {
    expect(
      shouldFinalizeCleanClose({
        isDirty: false,
        serverRef,
        saveStatus: "saved",
        confirmedSavedServer: true,
      }),
    ).toBe(true);
  });

  it("successful autosave then clean close finalizes (content is remote)", () => {
    expect(shouldFinalizeCleanClose({ isDirty: false, serverRef, saveStatus: "saved" })).toBe(true);
  });

  it("failed remote save preserves recovery", () => {
    expect(
      shouldFinalizeCleanClose({ isDirty: true, serverRef: null, saveStatus: "failed" }),
    ).toBe(false);
  });

  it("a dirty composer never finalizes", () => {
    expect(
      shouldFinalizeCleanClose({ isDirty: true, serverRef, saveStatus: "saving" }),
    ).toBe(false);
  });

  it("a local-only unsaved draft (no serverRef) never finalizes on clean close", () => {
    expect(
      shouldFinalizeCleanClose({ isDirty: false, serverRef: null, saveStatus: "idle" }),
    ).toBe(false);
  });

  it("explicitly opening an existing server Draft keeps its content (no local wipe)", () => {
    // isEditMode ignores the local v3 doc and reads the server draft instead.
    const src = route();
    expect(src).toContain("if (isEditMode) return null;");
  });
});

describe("recovery document lifecycle", () => {
  it("clearDraftDoc removes the recovery doc so the next read is null", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    writeDraftDoc(storage, "a@example.com", {
      version: 3,
      draftId: "draft-1",
      snapshot: {
        to: [{ email: "x@example.com", valid: true }],
        cc: [],
        bcc: [],
        subject: "hi",
        html: "<p>hi</p>",
        showCc: false,
        showBcc: false,
      },
      serverRef,
      updatedAt: 1,
    });
    expect(readDraftDoc(storage, "a@example.com")).not.toBeNull();
    clearDraftDoc(storage, "a@example.com");
    expect(readDraftDoc(storage, "a@example.com")).toBeNull();
  });
});

describe("clean-close wiring (mail.tsx)", () => {
  it("finalizes on the clean close path", () => {
    const src = route();
    const clean = src.slice(src.indexOf("if (!isDirtyRef.current) {"), src.indexOf("const choice = await"));
    expect(clean).toContain("finalizeCleanClose();");
    expect(clean).toContain("closeComposer();");
  });

  it("finalizes a confirmed save close and save-as-draft close", () => {
    const src = route();
    expect(src.split("finalizeCleanClose({ confirmedSavedServer: true })").length - 1).toBe(2);
  });

  it("cancel close never finalizes", () => {
    const src = route();
    const cancel = src.slice(src.indexOf('if (choice === "cancel")'), src.indexOf('if (choice === "save")'));
    expect(cancel).toContain("return false;");
    expect(cancel).not.toContain("finalizeCleanClose");
  });

  it("failed save never finalizes", () => {
    const src = route();
    const save = src.slice(src.indexOf('if (choice === "save")'), src.indexOf("// discard"));
    expect(save).toContain('if (result === "saved_server")');
    expect(save).toContain("return false;");
  });

  it("keeps the beforeunload guard so crash/unmount still preserves recovery", () => {
    const src = route();
    expect(src).toContain("attachBeforeUnloadGuard(window, () => isDirtyRef.current)");
  });
});
