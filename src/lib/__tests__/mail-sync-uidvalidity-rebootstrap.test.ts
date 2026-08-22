import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const runner = () =>
  readFileSync(new URL("../mail-sync-runner.server.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function inOrder(source: string, markers: string[]) {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, "missing marker: " + marker).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("UIDVALIDITY reset rebootstrap contract", () => {
  it("self-heals an incomplete cursor by falling back to an initial round", () => {
    const src = runner();
    expect(src).toContain('const effectiveMode: RunMailSyncCoreInput["mode"] =');
    expect(src).toContain('cursor.newest_synced_uid == null');
    expect(src).toContain('if (effectiveMode === "initial")');
    expect(src).toContain('} else if (effectiveMode === "incremental")');
    expect(src).not.toContain('code: "NO_CURSOR"');
  });

  it("rebootstraps both incremental and reconcile resetRequired paths", () => {
    const src = runner();
    const calls = src.match(/await rebootstrapAfterUidValidityReset\(\);/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("wipes old UID identities before inserting fresh initial UIDs and restoring the cursor", () => {
    const src = runner();
    const start = src.indexOf("const rebootstrapAfterUidValidityReset = async");
    const end = src.indexOf('if (effectiveMode === "initial")', start);
    const body = src.slice(start, end);
    inOrder(body, [
      'bridgePost("/api/sync/initial"',
      "await wipeFolderForUidValidityReset",
      "wroteMessages = await upsertMessagesInBatches",
      "await updateSyncCursor",
      "oldestSyncedUid: fresh.oldestReturnedUid",
      "newestSyncedUid: fresh.newestReturnedUid",
    ]);
  });

  it("never leaves a reset with a deliberately null newest cursor", () => {
    const src = runner();
    const resetSections = src.split("if (result.resetRequired)").slice(1);
    expect(resetSections).toHaveLength(2);
    for (const section of resetSections) {
      const branch = section.slice(0, section.indexOf("} else {"));
      expect(branch).toContain("await rebootstrapAfterUidValidityReset();");
      expect(branch).not.toContain("newestSyncedUid: null");
    }
  });
});
