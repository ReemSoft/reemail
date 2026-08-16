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
    // The automatic remote-save flush and the scheduler fire both fence.
    expect(src).toContain("// DELETE INTENT fence: never start a remote save while deleting.");
    expect(src).toContain("// DELETE INTENT fence: block any new autosave (local write + remote).");
    expect(src).toContain("if (deleteIntentRef.current) return;");
  });

  it("waits for the in-flight save before the remote delete", () => {
    const src = route();
    expect(src).toContain("await saverRef.current?.awaitIdle();");
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
