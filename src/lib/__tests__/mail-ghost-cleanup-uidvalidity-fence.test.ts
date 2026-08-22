import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("ghost cleanup UIDVALIDITY write-through fence", () => {
  it("forwards the caller-proven generation into applyDeleteWriteThrough", () => {
    const src = readFileSync(
      new URL("../mail-ghost-cleanup.functions.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    const start = src.indexOf("const outcome = await applyDeleteWriteThrough");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf("});", start);
    expect(end).toBeGreaterThan(start);

    const call = src.slice(start, end + 3);
    expect(call).toContain("sourceCanonical: data.canonical");
    expect(call).toContain("sourceUid: data.uid");
    expect(call).toContain("sourceUidValidity: data.uidvalidity");
  });

  it("keeps the existing mismatch precheck in front of the final tombstone", () => {
    const src = readFileSync(
      new URL("../mail-ghost-cleanup.functions.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    const precheck = src.indexOf("if (folder?.uidvalidity != null && folder.uidvalidity !== data.uidvalidity)");
    const write = src.indexOf("const outcome = await applyDeleteWriteThrough");
    expect(precheck).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(precheck);
  });
});
