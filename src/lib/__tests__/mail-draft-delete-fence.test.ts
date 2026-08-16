// Draft delete-intent fence + save→delete ordering — wiring regression guards.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

describe("delete-intent fence (mail.tsx)", () => {
  it("declares a delete-intent ref and guards duplicate clicks", () => {
    const src = route();
    expect(src).toContain("const deleteIntentRef = useRef(false);");
    expect(src).toContain("if (deletingDraft || deleteIntentRef.current) return;");
  });

  it("blocks NEW autosaves while delete intent is active", () => {
    const src = route();
    expect(src).toContain("canStartRemoteAutosave(");
    expect(src).toContain("if (!isDirtyRef.current) return;");
    expect(src).toContain("deleteIntent: deleteIntentRef.current");
  });

  it("fences Close from saving or closing while delete intent is active", () => {
    const src = route();
    const requestClose = src.slice(
      src.indexOf("async function requestClose()"),
      src.indexOf("const requestCloseRef = useRef"),
    );
    expect(requestClose).toContain("if (deleteIntentRef.current) return false;");
  });

  it("fences Save-as-Draft from saving after delete intent", () => {
    const src = route();
    const saveAs = src.slice(
      src.indexOf("async function handleSaveAsDraft()"),
      src.indexOf("async function handleDeleteDraft()"),
    );
    expect(saveAs).toContain("if (deleteIntentRef.current) return;");
  });

  it("fences saveDraftNow before and after the save await", () => {
    const src = route();
    const saveNow = src.slice(
      src.indexOf("async function saveDraftNow("),
      src.indexOf("async function handleSaveAsDraft()"),
    );
    expect(saveNow).toContain('if (deleteIntentRef.current) return "failed";');
    expect(saveNow).toContain("if (deleteIntentRef.current) return \"failed\";");
  });

  it("waits for the in-flight save before the remote delete", () => {
    const src = route();
    expect(src).toContain("await saverRef.current?.cancelPendingAndAwaitRunning();");
  });

  it("does NOT re-arm autosave after a failed delete", () => {
    const src = route();
    const failure = src.slice(
      src.indexOf('if (!deleted.ok) {'),
      src.indexOf("} else {", src.indexOf('if (!deleted.ok) {')),
    );
    expect(failure).toContain("deleteIntentRef.current = false;");
    expect(failure).not.toContain("autosaveRef.current?.schedule()");
  });

  it("propagates the coarse safe code instead of discarding it", () => {
    const src = route();
    expect(src).toContain('return { ok: false, code: "SESSION_REQUIRED" };');
    expect(src).toContain('return { ok: false, code: result?.code ?? "UNKNOWN" };');
    expect(src).toContain('console.error("[draft-delete] failed code=", deleted.code)');
  });

  it("releaseAllOwnedStagedHandles + onDraftDeleted still run on success", () => {
    const src = route();
    const success = src.slice(src.indexOf('console.error("[draft-delete] failed code=', 0));
    expect(success).toContain("releaseAllOwnedStagedHandles();");
    expect(success).toContain("onDraftDeleted(draftId);");
  });
});
