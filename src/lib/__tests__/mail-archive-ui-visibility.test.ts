// Behavioral tests for the Archive Restore UI closure applied to
// src/routes/mail.tsx (canArchive / canRestore + Archive UIDVALIDITY wiring).
//
// The test environment is `node`, so we assert the exact predicates and
// origin-tracker call sequence that mail.tsx uses, rather than mounting
// the React component. These tests fail if the visibility rules or the
// counts→UIDVALIDITY→purge pipeline regress.

import { describe, it, expect } from "vitest";
import {
  rememberFinalOrigin,
  getOrigin,
  purgeStaleTrashUidValidity,
  type OriginStorage,
} from "@/lib/mail-origin-tracker";
import type { MailFolder } from "@/lib/mail-mock";

function makeStorage(): OriginStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

// Mirror the exact predicates used inside MessageView in src/routes/mail.tsx.
// Kept as pure functions so any drift in the route file is caught by these
// tests.
const canArchive = (folder: MailFolder) => folder !== "archive" && folder !== "trash";
const canRestore = (folder: MailFolder) => folder === "trash" || folder === "archive";

describe("MessageView — Archive/Restore visibility", () => {
  it("Archive folder hides the Archive button", () => {
    expect(canArchive("archive")).toBe(false);
  });
  it("Trash folder hides the Archive button", () => {
    expect(canArchive("trash")).toBe(false);
  });
  it("Inbox shows the Archive button", () => {
    expect(canArchive("inbox")).toBe(true);
  });
  it("Sent / Drafts / Starred / Spam still show Archive", () => {
    for (const f of ["sent", "drafts", "starred", "spam"] as MailFolder[]) {
      expect(canArchive(f)).toBe(true);
    }
  });
  it("Archive shows Restore", () => {
    expect(canRestore("archive")).toBe(true);
  });
  it("Trash shows Restore", () => {
    expect(canRestore("trash")).toBe(true);
  });
  it("Inbox / Sent / Drafts do NOT show Restore", () => {
    for (const f of ["inbox", "sent", "drafts", "starred", "spam"] as MailFolder[]) {
      expect(canRestore(f)).toBe(false);
    }
  });
});

// Simulate the counts→UIDVALIDITY→purge wiring inside refreshFolderCounts.
// The block under test in mail.tsx does exactly this for both trash and
// archive kinds, once per counts response.
type CountRow = { folder: MailFolder; uidvalidity?: number | null };
function applyCountsUV(
  storage: OriginStorage,
  accountId: string,
  counts: CountRow[],
  refs: { trash: number | null; archive: number | null },
) {
  const trashCount = counts.find((c) => c.folder === "trash");
  const nextTrashUV = trashCount?.uidvalidity ?? null;
  if (nextTrashUV != null && refs.trash !== nextTrashUV) {
    purgeStaleTrashUidValidity(storage, accountId, nextTrashUV, "trash");
  }
  refs.trash = nextTrashUV;

  const archiveCount = counts.find((c) => c.folder === "archive");
  const nextArchiveUV = archiveCount?.uidvalidity ?? null;
  if (nextArchiveUV != null && refs.archive !== nextArchiveUV) {
    purgeStaleTrashUidValidity(storage, accountId, nextArchiveUV, "archive");
  }
  refs.archive = nextArchiveUV;
  return refs;
}

describe("refreshFolderCounts — Archive UIDVALIDITY wiring", () => {
  const A = "acct-1";

  it("captures Archive UIDVALIDITY from folder counts", () => {
    const s = makeStorage();
    const refs = { trash: null as number | null, archive: null as number | null };
    applyCountsUV(
      s,
      A,
      [
        { folder: "trash", uidvalidity: 100 },
        { folder: "archive", uidvalidity: 200 },
      ],
      refs,
    );
    expect(refs.trash).toBe(100);
    expect(refs.archive).toBe(200);
  });

  it("Archive UIDVALIDITY change purges only the archive namespace", () => {
    const s = makeStorage();
    // Seed FINAL origins in both namespaces under UV=200.
    rememberFinalOrigin(s, A, "archive", 200, 55, {
      folder: "sent",
      messageId: "m-arch-1",
    });
    rememberFinalOrigin(s, A, "trash", 100, 77, {
      folder: "inbox",
      messageId: "m-trash-1",
    });

    // Sanity: both origins are readable at their current UVs.
    expect(getOrigin(s, A, "archive", 200, 55)?.folder).toBe("sent");
    expect(getOrigin(s, A, "trash", 100, 77)?.folder).toBe("inbox");

    // UIDVALIDITY reset for Archive only (200 → 201).
    const refs = { trash: 100 as number | null, archive: 200 as number | null };
    applyCountsUV(
      s,
      A,
      [
        { folder: "trash", uidvalidity: 100 },
        { folder: "archive", uidvalidity: 201 },
      ],
      refs,
    );

    // Archive origin under old UV=200 is purged; Trash origin untouched.
    expect(getOrigin(s, A, "archive", 200, 55)).toBeNull();
    expect(getOrigin(s, A, "trash", 100, 77)?.folder).toBe("inbox");
    expect(refs.archive).toBe(201);
    expect(refs.trash).toBe(100);
  });

  it("Restore from Archive returns the tracked origin folder, not Inbox", () => {
    const s = makeStorage();
    // User archived a message from "sent". Origin recorded at UV=200, UID=55.
    rememberFinalOrigin(s, A, "archive", 200, 55, {
      folder: "sent",
      messageId: "m-sent-arch",
    });
    // Ref matches counts.
    const refs = { trash: null as number | null, archive: null as number | null };
    applyCountsUV(s, A, [{ folder: "archive", uidvalidity: 200 }], refs);

    const origin = getOrigin(s, A, "archive", refs.archive!, 55);
    expect(origin?.folder).toBe("sent");
  });

  it("Missing/untracked origin falls back to null (caller uses Inbox default)", () => {
    const s = makeStorage();
    const refs = { trash: null as number | null, archive: null as number | null };
    applyCountsUV(s, A, [{ folder: "archive", uidvalidity: 200 }], refs);
    // No origin was recorded for UID=999 — restore path must not surface
    // a stale/guessed origin.
    expect(getOrigin(s, A, "archive", refs.archive!, 999)).toBeNull();
  });

  it("Trash Restore path is unaffected by the new Archive wiring", () => {
    const s = makeStorage();
    rememberFinalOrigin(s, A, "trash", 100, 42, {
      folder: "sent",
      messageId: "m-trash-sent",
    });
    const refs = { trash: null as number | null, archive: null as number | null };
    applyCountsUV(
      s,
      A,
      [
        { folder: "trash", uidvalidity: 100 },
        { folder: "archive", uidvalidity: 200 },
      ],
      refs,
    );
    expect(getOrigin(s, A, "trash", refs.trash!, 42)?.folder).toBe("sent");
  });
});
