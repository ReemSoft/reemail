import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = () =>
  readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("provider-only Draft NOT_FOUND Local Index convergence", () => {
  it("tombstones the exact physical Draft projection before hiding the row", () => {
    const src = source();
    const marker = "// Provider-only/legacy physical Draft disappeared and there is";
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);

    const end = src.indexOf('if (parsed.folder !== "all")', start);
    expect(end).toBeGreaterThan(start);
    const branch = src.slice(start, end);

    expect(branch).toContain("await cleanupGhost({");
    expect(branch).toContain('canonical: "drafts"');
    expect(branch).toContain("uid: fetchUid");
    expect(branch).toContain("uidvalidity: uidValidity ? Number(uidValidity) : undefined");
    expect(branch).toContain("await loadCountsFast({ draftIndexSyncSettled: true })");

    expect(branch.indexOf("await cleanupGhost({")).toBeLessThan(
      branch.indexOf("messageCache.current.delete(id)")
    );
    expect(branch.indexOf("await loadCountsFast")).toBeLessThan(
      branch.indexOf("messageCache.current.delete(id)")
    );
  });

  it("only reaches physical cleanup after logical Working Draft recovery is absent", () => {
    const src = source();
    const marker = "// Provider-only/legacy physical Draft disappeared and there is";
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);

    const draftBranch = src.lastIndexOf('if (parsed.folder === "drafts")', start);
    expect(draftBranch).toBeGreaterThanOrEqual(0);
    const branch = src.slice(draftBranch, start);

    expect(branch).toContain("const logicalRecord = await resolveDraftWorkingRecord");
    expect(branch).toContain("if (logicalRecord)");
    expect(branch).toContain('source: "draft-working-record"');
  });

  it("keeps cleanup dependencies inside the fetchMessage callback fence", () => {
    const src = source();
    const start = src.indexOf("const fetchMessage = useCallback");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf("  const openHistoricalMessage", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("cleanupGhost");
    expect(body).toContain("loadCountsFast");
  });
});
