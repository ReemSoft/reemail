// Architecture regression guards for the canonical self-heal system.
//
// These are source-string checks (same technique as mail-draft-folder-open)
// that lock the structural invariants the behavioral tests rely on, so a
// future refactor can't silently reintroduce a `.maybeSingle()` duplicate-
// canonical crash or drop the authoritative folderPaths bootstrap.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexFn = () => readFileSync(new URL("../mail-index.functions.ts", import.meta.url), "utf8");
const writer = () => readFileSync(new URL("../mail-sync-writer.server.ts", import.meta.url), "utf8");
const syncFn = () => readFileSync(new URL("../mail-sync.functions.ts", import.meta.url), "utf8");
const draftWriter = () => readFileSync(new URL("../mail-draft-writer.server.ts", import.meta.url), "utf8");
const syncHook = () => readFileSync(new URL("../../hooks/use-mail-index-sync.ts", import.meta.url), "utf8");
const mailRoute = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

describe("canonical self-heal architecture", () => {
  it("indexListMessages uses limit(2) and returns AMBIGUOUS_FOLDER on duplicates (no maybeSingle crash)", () => {
    const src = indexFn();
    expect(src).toContain(".limit(2)");
    expect(src).toContain('"AMBIGUOUS_FOLDER"');
    const folderQuery = src.slice(src.indexOf("---- 2) Resolve folder row"), src.indexOf("---- 3) Keyset"));
    expect(folderQuery).toContain(".limit(2)");
  });

  it("ensureFolderRow carries trustedCanonical and never erases canonical on null caller", () => {
    const src = writer();
    expect(src).toContain("trustedCanonical");
    expect(src).toContain("existingCanonical !== wantCanonical");
  });

  it("runMailSync only trusts canonical when the caller opts in (path provenance)", () => {
    expect(syncFn()).toContain("trustedCanonical: data.trustedCanonical === true");
  });

  it("useMailIndexSync only authorizes self-heal on an authoritative path", () => {
    const src = syncHook();
    expect(src).toContain("pathTrusted");
    expect(src).toContain("trustedCanonical: p.pathTrusted === true");
  });

  it("mail.tsx syncs on an authoritative path only (index-derived paths never reach the sync)", () => {
    const src = mailRoute();
    expect(src).toContain("authoritativeFolderPaths");
    expect(src).toContain("folderPath: authoritativeFolderPath");
    expect(src).toContain("pathTrusted: authoritativeFolderPath != null");
  });

  it("draft projection writes are trusted (repair a mislabelled Drafts row)", () => {
    expect(draftWriter()).toContain("trustedCanonical: true");
  });

  it("loadCountsFast bootstraps folderPaths from authoritative bridge counts", () => {
    const src = mailRoute();
    const idx = src.indexOf("MAILMAESTRO_CANONICAL_SELFHEAL bootstrap");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 800)).toContain("setFolderPaths");
  });
});
