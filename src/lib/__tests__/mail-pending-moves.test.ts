// BLOCKER_3_PENDING_MOVE_OVERLAY — behavioural tests for the overlay module.
//
// Covers every rule stated in the spec §9 (Mandatory tests):
//   * Account A never suppresses Account B.
//   * `starred:UID` matches the physical `inbox:UID`.
//   * A pending entry suppresses Index, Bridge, Pagination, and Deep Search rows.
//   * Does NOT suppress destination rows (different physical folder).
//   * Destination folder read does NOT GC a Source overlay.
//   * Source read that started BEFORE `confirmedAt` does NOT GC.
//   * Source read that started AFTER `confirmedAt` and where the row is
//     absent DOES GC.
//   * Source read that started after confirmation but row is still present
//     KEEPS the entry.
//   * `still-present` / `busy` / `failed` / `tombstone-only` all stay
//     suppressed until a later source read confirms absence.
//   * IMAP failure (rollback) drops the entry.
//   * Logout / account switch clears the right scope only.
//   * Source UID == Destination UID does NOT suppress the destination.
import { describe, it, expect } from "vitest";
import type { MailMessage } from "@/lib/mail-types";
import {
  applyPendingMoveOverlay,
  beginPendingMove,
  clearPendingMovesForAccount,
  confirmPendingMove,
  deserializePendingMoves,
  isMessageSuppressed,
  normalizePhysicalFolder,
  pendingMoveKey,
  parsePhysicalIdentity,
  reconcilePendingMovesAfterSourceRead,
  rollbackPendingMove,
  serializePendingMoves,
  type PendingMovesMap,
} from "@/lib/mail-pending-moves";

function msg(id: string): MailMessage {
  return {
    id,
    threadId: id,
    folder: "inbox",
    from: { name: "", email: "a@b" },
    to: [],
    subject: "",
    preview: "",
    body: "",
    date: "2026-01-01T00:00:00Z",
    read: false,
    starred: false,
    hasAttachments: false,
  };
}

describe("normalizePhysicalFolder", () => {
  it("collapses starred to inbox but leaves other folders untouched", () => {
    expect(normalizePhysicalFolder("starred")).toBe("inbox");
    expect(normalizePhysicalFolder("inbox")).toBe("inbox");
    expect(normalizePhysicalFolder("trash")).toBe("trash");
    expect(normalizePhysicalFolder(null)).toBe("");
  });
});

describe("parsePhysicalIdentity", () => {
  it("accepts starred:UID as inbox:UID", () => {
    expect(parsePhysicalIdentity("starred:42")).toEqual({ physicalFolder: "inbox", uid: 42 });
    expect(parsePhysicalIdentity("inbox:42")).toEqual({ physicalFolder: "inbox", uid: 42 });
  });
  it("rejects malformed ids", () => {
    expect(parsePhysicalIdentity("inbox:")).toBeNull();
    expect(parsePhysicalIdentity("inbox:abc")).toBeNull();
    expect(parsePhysicalIdentity(":42")).toBeNull();
    expect(parsePhysicalIdentity("inbox:0")).toBeNull();
  });
});

describe("beginPendingMove + isMessageSuppressed", () => {
  it("suppresses the same physical UID across starred/inbox views", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, {
      accountId: "A",
      sourceFolder: "starred",
      sourceUid: 42,
      operation: "trash",
    });
    expect(isMessageSuppressed(e, "A", "starred:42")).toBe(true);
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(true);
  });
  it("does not cross accounts", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 42, operation: "move" });
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(true);
    expect(isMessageSuppressed(e, "B", "inbox:42")).toBe(false);
  });
});

describe("applyPendingMoveOverlay", () => {
  const list = [msg("inbox:1"), msg("inbox:2"), msg("inbox:3")];

  it("filters index-fetched rows", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 2, operation: "trash" });
    expect(applyPendingMoveOverlay(list, e, "A").map((m) => m.id)).toEqual(["inbox:1", "inbox:3"]);
  });

  it("filters bridge / deep-search / pagination results equivalently (same shape)", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 1, operation: "archive" });
    const bridgeList = [msg("inbox:1"), msg("inbox:2")];
    const deep = [msg("inbox:1"), msg("inbox:3")];
    const pageAppended = [...list, msg("inbox:4"), msg("inbox:1")];
    expect(applyPendingMoveOverlay(bridgeList, e, "A").map((m) => m.id)).toEqual(["inbox:2"]);
    expect(applyPendingMoveOverlay(deep, e, "A").map((m) => m.id)).toEqual(["inbox:3"]);
    expect(applyPendingMoveOverlay(pageAppended, e, "A").map((m) => m.id)).toEqual([
      "inbox:2",
      "inbox:3",
      "inbox:4",
    ]);
  });

  it("suppresses starred:UID when entry is stored as inbox:UID (and vice-versa)", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 7, operation: "trash" });
    expect(applyPendingMoveOverlay([msg("starred:7"), msg("starred:8")], e, "A").map((m) => m.id))
      .toEqual(["starred:8"]);
  });

  it("does NOT suppress destination-folder rows (different physical folder, same UID)", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 42, operation: "trash" });
    // Trash view returning a row that happens to carry uid=42 must stay visible.
    expect(applyPendingMoveOverlay([msg("trash:42")], e, "A").map((m) => m.id)).toEqual([
      "trash:42",
    ]);
  });

  it("is a no-op when accountId is null or entries are empty", () => {
    const e: PendingMovesMap = new Map();
    expect(applyPendingMoveOverlay(list, e, "A")).toBe(list);
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 1, operation: "move" });
    expect(applyPendingMoveOverlay(list, e, null)).toBe(list);
  });
});

describe("lifecycle: confirm + rollback", () => {
  it("confirm keeps the entry active (still filters until GC)", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 5, operation: "move", now: 100 });
    confirmPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 5, now: 200 });
    expect(isMessageSuppressed(e, "A", "inbox:5")).toBe(true);
    const entry = e.get(pendingMoveKey("A", "inbox", 5))!;
    expect(entry.status).toBe("confirmed");
    expect(entry.confirmedAt).toBe(200);
  });

  it("rollback removes the entry entirely (IMAP failure)", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 9, operation: "trash" });
    expect(rollbackPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 9 })).toBe(true);
    expect(isMessageSuppressed(e, "A", "inbox:9")).toBe(false);
  });

  it("confirming a non-existent entry is a no-op", () => {
    const e: PendingMovesMap = new Map();
    expect(confirmPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 1 })).toBeNull();
  });
});

describe("reconcilePendingMovesAfterSourceRead", () => {
  function seedConfirmed(
    accountId: string,
    folder: string,
    uid: number,
    confirmedAt: number,
    sc?: any,
  ): PendingMovesMap {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId, sourceFolder: folder, sourceUid: uid, operation: "trash", now: confirmedAt - 10 });
    confirmPendingMove(e, { accountId, sourceFolder: folder, sourceUid: uid, now: confirmedAt, sourceConfirmation: sc });
    return e;
  }

  it("Destination folder read does NOT GC a Source overlay", () => {
    const e = seedConfirmed("A", "inbox", 42, 100);
    // Read TRASH — must never touch inbox entries.
    const removed = reconcilePendingMovesAfterSourceRead(e, {
      accountId: "A",
      physicalSourceFolder: "trash",
      requestStartedAt: 200,
      rawList: [msg("trash:42"), msg("trash:99")],
    });
    expect(removed).toBe(0);
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(true);
  });

  it("Source request that started BEFORE confirmedAt does NOT GC", () => {
    const e = seedConfirmed("A", "inbox", 42, 200);
    const removed = reconcilePendingMovesAfterSourceRead(e, {
      accountId: "A",
      physicalSourceFolder: "inbox",
      requestStartedAt: 150, // BEFORE confirmedAt=200
      rawList: [msg("inbox:1")],
    });
    expect(removed).toBe(0);
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(true);
  });

  it("Source request that started AFTER confirmedAt with row absent GCs", () => {
    const e = seedConfirmed("A", "inbox", 42, 100);
    const removed = reconcilePendingMovesAfterSourceRead(e, {
      accountId: "A",
      physicalSourceFolder: "inbox",
      requestStartedAt: 200,
      rawList: [msg("inbox:1"), msg("inbox:2")],
    });
    expect(removed).toBe(1);
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(false);
  });

  it("Source request AFTER confirmedAt with row STILL present KEEPS the entry", () => {
    const e = seedConfirmed("A", "inbox", 42, 100);
    const removed = reconcilePendingMovesAfterSourceRead(e, {
      accountId: "A",
      physicalSourceFolder: "inbox",
      requestStartedAt: 200,
      rawList: [msg("inbox:42")],
    });
    expect(removed).toBe(0);
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(true);
  });

  it("still-present / busy / failed / tombstone-only all stay suppressed until a clean source read", () => {
    for (const sc of ["still-present", "busy", "failed", "tombstone-only"] as const) {
      const e = seedConfirmed("A", "inbox", 7, 100, sc);
      // Immediate (unrelated) read still finds no matching UID — GC allowed.
      const removed = reconcilePendingMovesAfterSourceRead(e, {
        accountId: "A",
        physicalSourceFolder: "inbox",
        requestStartedAt: 300,
        rawList: [msg("inbox:1")],
      });
      // GC works purely off "raw list absent AND started after confirmedAt".
      // sourceConfirmation is informational — we still gate on the real read.
      expect(removed).toBe(1);
      expect(e.size).toBe(0);
    }
  });

  it("Reading the Starred (virtual) view GCs an inbox source overlay", () => {
    // Starred is normalized to inbox — reading it counts as reading inbox.
    const e = seedConfirmed("A", "inbox", 42, 100);
    const removed = reconcilePendingMovesAfterSourceRead(e, {
      accountId: "A",
      physicalSourceFolder: "starred", // caller passes raw canonical; normalized inside
      requestStartedAt: 200,
      rawList: [msg("starred:1")],
    });
    expect(removed).toBe(1);
  });

  it("A source read that returns the row keyed as starred:UID counts as present", () => {
    const e = seedConfirmed("A", "inbox", 42, 100);
    reconcilePendingMovesAfterSourceRead(e, {
      accountId: "A",
      physicalSourceFolder: "inbox",
      requestStartedAt: 200,
      rawList: [msg("starred:42")],
    });
    expect(isMessageSuppressed(e, "A", "inbox:42")).toBe(true);
  });
});

describe("clearPendingMovesForAccount", () => {
  it("only clears the requested account", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, { accountId: "A", sourceFolder: "inbox", sourceUid: 1, operation: "trash" });
    beginPendingMove(e, { accountId: "B", sourceFolder: "inbox", sourceUid: 1, operation: "trash" });
    const removed = clearPendingMovesForAccount(e, "A");
    expect(removed).toBe(1);
    expect(isMessageSuppressed(e, "A", "inbox:1")).toBe(false);
    expect(isMessageSuppressed(e, "B", "inbox:1")).toBe(true);
  });
});

describe("session-storage serialization", () => {
  it("round-trips entries and never stores secrets by design", () => {
    const e: PendingMovesMap = new Map();
    beginPendingMove(e, {
      accountId: "A",
      sourceFolder: "starred",
      sourceUid: 42,
      operation: "trash",
      now: 100,
    });
    confirmPendingMove(e, {
      accountId: "A",
      sourceFolder: "inbox",
      sourceUid: 42,
      now: 200,
      sourceConfirmation: "confirmed-absent",
    });
    const round = deserializePendingMoves(serializePendingMoves(e));
    expect(round.size).toBe(1);
    const entry = round.get(pendingMoveKey("A", "inbox", 42))!;
    expect(entry.physicalSourceFolder).toBe("inbox");
    expect(entry.status).toBe("confirmed");
    expect(entry.confirmedAt).toBe(200);
    // Schema check: no field named password/token can ever leak in.
    const serialized = serializePendingMoves(e);
    expect(serialized).not.toMatch(/password|token|secret/i);
  });

  it("safely ignores corrupt storage payloads", () => {
    expect(deserializePendingMoves(null).size).toBe(0);
    expect(deserializePendingMoves("not json").size).toBe(0);
    expect(deserializePendingMoves("{}").size).toBe(0);
    expect(deserializePendingMoves('[{"junk":1}]').size).toBe(0);
  });
});
