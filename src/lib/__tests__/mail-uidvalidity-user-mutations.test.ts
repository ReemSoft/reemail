import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("UIDVALIDITY fencing for user UID mutations", () => {
  it("browser derives expected identity from the already-loaded message row with no new I/O", () => {
    const src = read("../../routes/mail.tsx");
    const start = src.indexOf("const mutateFlag = useCallback");
    const end = src.indexOf("// Per-id single-flight guard", start);
    const body = src.slice(start, end);
    expect(body).toContain("messagesRef.current.find");
    expect(body).toContain("validUidValidity(");
    expect(body).toContain("uidValidity: expectedUidValidity");
    expect(body).not.toContain("await loadCounts");
    expect(body).not.toContain("await incrementalNow");
  });

  it("raw Bridge server functions translate row uidValidity into expectedUidValidity", () => {
    const src = read("../mail-bridge.functions.ts");
    expect(src).toContain("const MutationMessagePayloadSchema");
    expect(src).toContain("uidValidity: z.string()");
    expect((src.match(/expectedUidValidity: data\.uidValidity/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("preferred flag/move/delete paths all require and forward uidValidity", () => {
    const flags = read("../mail-flags.functions.ts");
    const move = read("../mail-move.functions.ts");
    const del = read("../mail-delete.functions.ts");
    for (const src of [flags, move, del]) {
      expect(src).toContain("uidValidity: z.string()");
      expect(src).toContain("expectedUidValidity");
    }
    expect(move).toContain("sourceUidValidity: Number(data.uidValidity)");
    expect(del).toContain("sourceUidValidity: Number(data.uidValidity)");
  });

  it("post-IMAP Local Index writes stay bound to the generation Bridge accepted", () => {
    const flags = read("../mail-flags.functions.ts");
    const moveWriter = read("../mail-move-writer.server.ts");
    const deleteWriter = read("../mail-delete-writer.server.ts");
    expect(flags).toContain('String(folder.uidvalidity) !== data.uidValidity');
    expect(moveWriter).toContain("input.sourceUidValidity ?? src.uidvalidity");
    expect(deleteWriter).toContain("input.sourceUidValidity ?? src.uidvalidity");
  });
});
