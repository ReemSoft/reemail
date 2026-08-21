import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const sql = () => readFileSync(
  new URL("../../../supabase/migrations/20260822005000_working_draft_cross_instance_singleflight.sql", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const server = () => readFileSync(
  new URL("../mail-working-draft.server.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("cross-instance Working Draft single-flight", () => {
  const migration = sql();
  const source = server();

  it("adds durable cleanup and import leases", () => {
    for (const marker of [
      "cleanup_claim_token uuid",
      "cleanup_lease_until timestamptz",
      "import_claim_token uuid",
      "import_lease_until timestamptz",
    ]) expect(migration).toContain(marker);
  });

  it("uses token-fenced discard cleanup claims", () => {
    expect(migration).toContain("claim_mail_working_draft_discard_cleanup");
    expect(migration).toContain("advance_mail_working_draft_discard_cleanup");
    expect(migration).toContain("fail_mail_working_draft_discard_cleanup");
    expect(migration).toContain("d.cleanup_lease_until<now()");
    expect(migration).toContain("RETURNING d.cleanup_claim_token, d.provider_refs");
    expect(migration).toContain("cleanup_claim_token=p_claim_token");
  });

  it("invalidates an in-flight cleanup when a late provider ref appears", () => {
    expect(migration).toContain("cleanup_state = 'pending'");
    expect(migration).toContain("cleanup_claim_token = NULL");
    expect(migration).toContain("cleanup_lease_until = NULL");
  });

  it("token-fences provider attachment import", () => {
    expect(migration).toContain("claim_mail_working_draft_attachment_import");
    expect(migration).toContain("finish_mail_working_draft_attachment_import");
    expect(migration).toContain("release_mail_working_draft_attachment_import");
    expect(migration).toContain("import_claim_token=p_claim_token");
  });

  it("claims cleanup before provider delete", () => {
    const start = source.indexOf("async function cleanupDiscardedWorkingDraft(");
    const end = source.indexOf("function startDiscardedCleanup(", start);
    const body = source.slice(start, end);
    expect(body.indexOf("claimDiscardedCleanup(auth, draftId)")).toBeGreaterThan(-1);
    expect(body.indexOf("claimDiscardedCleanup(auth, draftId)")).toBeLessThan(
      body.indexOf("deleteProviderDraftExplicit"),
    );
  });

  it("claims import before provider download and waits for another instance winner", () => {
    const start = source.indexOf("async function importExternalAttachment(");
    const end = source.indexOf("async function stageOwnedAttachment(", start);
    const body = source.slice(start, end);
    expect(body.indexOf("claimExternalAttachmentImport(auth, row)")).toBeGreaterThan(-1);
    expect(body.indexOf("claimExternalAttachmentImport(auth, row)")).toBeLessThan(
      body.indexOf("/api/draft-source-attachment"),
    );
    expect(body).toContain("waitForExternalAttachmentImport(auth, row)");
  });

  it("retains same-process maps only as a local fast path", () => {
    expect(source).toContain("discardedCleanupFlights");
    expect(source).toContain("externalImportFlights");
    expect(source).toContain('"claim_mail_working_draft_discard_cleanup"');
    expect(source).toContain('"claim_mail_working_draft_attachment_import"');
  });
});
