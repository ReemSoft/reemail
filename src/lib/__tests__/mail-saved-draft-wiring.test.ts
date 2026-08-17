// Just-saved Draft readability guard — wiring regression guards (mail.tsx).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

describe("just-saved Draft readability wiring", () => {
  it("records the exact identity ONLY on a confirmed remote save (status === saved)", () => {
    const src = route();
    expect(src).toMatch(/onDraftSaved\(\s*\{/);
    // The save-success branch is the only place onDraftSaved is invoked.
    const savedBranch = src.slice(
      src.indexOf('if (status === "saved") {'),
      src.indexOf('} else if (status === "failed")'),
    );
    expect(savedBranch).toMatch(/onDraftSaved\(\s*\{/);
    expect(savedBranch).toContain("folderPath: serverRef.folderPath");
    expect(savedBranch).toContain("uidValidity: serverRef.uidValidity");
    expect(savedBranch).toContain("uid: serverRef.uid");
    // No onDraftSaved in the failure branch.
    const failedBranch = src.slice(
      src.indexOf('} else if (status === "failed")'),
      src.indexOf('// status === "failed" → no savedGeneration advance'),
    );
    expect(failedBranch).not.toContain("onDraftSaved");
  });

  it("intercepts ONLY canonical drafts before ghost cleanup", () => {
    const src = route();
    expect(src).toContain('parsed.folder === "drafts" && currentAccountId');
    const notFound = src.slice(
      src.indexOf('if (!result.ok && result.code === "NOT_FOUND") {'),
      src.indexOf('toast.info(tr("تم إزالة رسالة مفقودة من القائمة"))'),
    );
    const guardIdx = notFound.indexOf("recoverJustSavedDraft(");
    const cleanupIdx = notFound.indexOf("void cleanupGhost({");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(guardIdx);
  });

  it("recovery uses incrementalNow (never /api/folders) and one retry", () => {
    const src = route();
    const recover = src.slice(
      src.indexOf("const recoverJustSavedDraft = useCallback"),
      src.indexOf("const fetchMessage = useCallback"),
    );
    expect(recover).toContain("await incrementalNow({ suppressOnSynced: true })");
    expect(recover).toContain("guard.markRecoveryAttempted(identity)");
    expect(recover).toContain('folder: "drafts"');
    expect(recover).not.toContain("getCounts");
    expect(recover).not.toContain("/api/folders");
  });

  it("surfaces a non-destructive transient state, not the generic failure", () => {
    const src = route();
    expect(src).toContain('"draft-syncing"');
    const open = src.slice(
      src.indexOf('} else if (result.source === "draft-syncing")'),
      src.indexOf("} else if (!cached)"),
    );
    expect(open).toContain("المسودة لا تزال قيد المزامنة");
    expect(open).not.toContain("فشل فتح الرسالة");
  });

  it("clears the marker on successful open, explicit delete, and account switch", () => {
    const src = route();
    expect(src).toContain(
      "savedDraftGuardRef.current?.clearDraft(matched.accountId, matched.draftId)",
    );
    expect(src).toContain("savedDraftGuardRef.current?.clearDraft(currentAccountId, draftId)");
    expect(src).toContain(
      "if (prev && prev !== currentAccountId) savedDraftGuardRef.current?.clearAll()",
    );
  });

  it("protection is identity-based, never attachment-based", () => {
    const src = route();
    expect(src).toContain("savedDraftGuardRef.current?.find(");
    // The guard decision is keyed by (accountId + uidValidity + uid) only —
    // the identity module never consults attachments.
    const guard = readFileSync(new URL("../mail-saved-draft-guard.ts", import.meta.url), "utf8");
    expect(guard).not.toContain("hasAttachments");
    expect(guard).not.toContain("attachment");
  });
});
