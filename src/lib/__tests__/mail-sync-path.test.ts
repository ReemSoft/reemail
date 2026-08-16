// Deterministic tests for the sync-path resolution invariant.
//
//   syncPath   = authoritativePath ?? uniqueNonAmbiguousIndexPath ?? null
//   pathTrusted = authoritativePath != null && syncPath === authoritativePath
//
// An index-derived path is never trusted (trustedCanonical stays false), so it
// can never authorize a canonical self-heal reassignment.
import { describe, expect, it } from "vitest";
import {
  resolveSyncPath,
  uniqueNonAmbiguousIndexPath,
  type IndexFolderPathRow,
} from "../mail-sync-path";

type F = IndexFolderPathRow["folder"];

function row(folder: F, path: string | null): IndexFolderPathRow {
  return { folder, path };
}

describe("uniqueNonAmbiguousIndexPath", () => {
  it("returns the path when a canonical appears exactly once with a non-null path", () => {
    const counts: IndexFolderPathRow[] = [
      row("inbox", "INBOX"),
      row("drafts", "[Gmail]/Drafts"),
      row("trash", "[Gmail]/Trash"),
    ];
    expect(uniqueNonAmbiguousIndexPath(counts, "drafts")).toBe("[Gmail]/Drafts");
  });

  it("returns null when the canonical is missing", () => {
    const counts: IndexFolderPathRow[] = [row("inbox", "INBOX")];
    expect(uniqueNonAmbiguousIndexPath(counts, "trash")).toBeNull();
  });

  it("returns null when the canonical appears more than once (ambiguous)", () => {
    const counts: IndexFolderPathRow[] = [
      row("trash", "[Gmail]/Trash"),
      row("trash", "[Gmail]/All Mail"),
    ];
    expect(uniqueNonAmbiguousIndexPath(counts, "trash")).toBeNull();
  });

  it("returns null when the single canonical row has a null path", () => {
    const counts: IndexFolderPathRow[] = [row("sent", null)];
    expect(uniqueNonAmbiguousIndexPath(counts, "sent")).toBeNull();
  });

  it("does not pick by array order when duplicates exist", () => {
    const counts: IndexFolderPathRow[] = [
      row("drafts", "[Gmail]/Drafts"),
      row("drafts", "INBOX.Drafts"),
    ];
    // First row would be "[Gmail]/Drafts" — order must not win.
    expect(uniqueNonAmbiguousIndexPath(counts, "drafts")).toBeNull();
  });
});

describe("resolveSyncPath", () => {
  it("unique index path + no authoritative path → syncPath=index path, pathTrusted=false", () => {
    const counts: IndexFolderPathRow[] = [row("drafts", "[Gmail]/Drafts")];
    const res = resolveSyncPath(null, counts, "drafts");
    expect(res.syncPath).toBe("[Gmail]/Drafts");
    expect(res.pathTrusted).toBe(false);
    expect(res.uniqueIndexPath).toBe("[Gmail]/Drafts");
  });

  it("authoritative path available → syncPath=authoritative path, pathTrusted=true", () => {
    const counts: IndexFolderPathRow[] = [row("drafts", "[Gmail]/Drafts")];
    const res = resolveSyncPath("[Gmail]/Drafts", counts, "drafts");
    expect(res.syncPath).toBe("[Gmail]/Drafts");
    expect(res.pathTrusted).toBe(true);
  });

  it("ambiguous duplicate canonical → no index syncPath", () => {
    const counts: IndexFolderPathRow[] = [
      row("trash", "[Gmail]/Trash"),
      row("trash", "[Gmail]/All Mail"),
    ];
    const res = resolveSyncPath(null, counts, "trash");
    expect(res.uniqueIndexPath).toBeNull();
    expect(res.syncPath).toBeNull();
    expect(res.pathTrusted).toBe(false);
  });

  it("missing canonical → no index syncPath", () => {
    const counts: IndexFolderPathRow[] = [row("inbox", "INBOX")];
    const res = resolveSyncPath(null, counts, "sent");
    expect(res.uniqueIndexPath).toBeNull();
    expect(res.syncPath).toBeNull();
    expect(res.pathTrusted).toBe(false);
  });

  it("untrusted index sync cannot repair canonical (pathTrusted=false)", () => {
    const counts: IndexFolderPathRow[] = [row("drafts", "[Gmail]/Drafts")];
    const res = resolveSyncPath(null, counts, "drafts");
    expect(res.syncPath).toBe("[Gmail]/Drafts");
    expect(res.pathTrusted).toBe(false);
  });

  it("authoritative sync can repair canonical (pathTrusted=true)", () => {
    const counts: IndexFolderPathRow[] = [];
    const res = resolveSyncPath("[Gmail]/Sent Mail", counts, "sent");
    expect(res.syncPath).toBe("[Gmail]/Sent Mail");
    expect(res.pathTrusted).toBe(true);
  });

  it("ambiguous/missing canonical still resolves through the authoritative path", () => {
    // Ambiguous canonical, but an authoritative path was provided — the
    // authoritative source must still be usable (and trusted) for resolution.
    const counts: IndexFolderPathRow[] = [
      row("trash", "[Gmail]/Trash"),
      row("trash", "[Gmail]/All Mail"),
    ];
    const res = resolveSyncPath("[Gmail]/Trash", counts, "trash");
    expect(res.uniqueIndexPath).toBeNull();
    expect(res.syncPath).toBe("[Gmail]/Trash");
    expect(res.pathTrusted).toBe(true);
  });
});
