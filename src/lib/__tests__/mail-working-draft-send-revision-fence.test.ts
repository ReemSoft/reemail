import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("working draft Send revision fence", () => {
  it("passes the browser-approved revision through every send boundary", () => {
    const mail = read("src/routes/mail.tsx");
    const route = read("src/routes/api/mail-working-draft-send.ts");
    const server = read("src/lib/mail-working-draft.server.ts");

    expect(mail).toContain("expectedRevision: workingRevisionRef.current");
    expect(route).toMatch(/working\.sendWorkingDraft\(\{\s*auth,\s*draftId,\s*expectedRevision,/);
    expect(server).toContain("p_expected_revision: expectedRevision");
    expect(server).toContain("record.revision !== input.expectedRevision");
  });

  it("seeds the authoritative revision before async Working Draft hydration", () => {
    const mail = read("src/routes/mail.tsx");

    expect(mail).toContain("workingDraftRevision?: number;");
    expect(mail).toContain("workingDraftRevision: record.revision");
    expect(mail).toContain("useRef(initial?.workingDraftRevision ?? 0)");

    // The server record load remains as freshness/hydration support, but a
    // direct Working Draft open no longer starts from revision zero.
    expect(mail).toContain("workingRevisionRef.current = record.revision");
  });

  it("atomically rejects stale sends and fences saves after Send claims", () => {
    const sql = read(
      "supabase/migrations/20260821152000_working_draft_send_revision_fence.sql",
    );

    expect(sql).toContain("current_revision <> p_expected_revision");
    expect(sql).toContain("WORKING_DRAFT_REVISION_CONFLICT");
    expect(sql).toContain("current_send_state IN ('preparing', 'sending', 'sent')");
    expect(sql).toContain("EXPECTED_REVISION_REQUIRED");
  });
});
