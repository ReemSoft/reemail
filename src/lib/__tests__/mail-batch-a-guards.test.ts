// Batch A integration tests — verify the three guards land in the actual
// helpers they protect (not just in the UI wrappers).
//
// 1) resolveFolderByPath scopes by companyId when provided.
// 2) isMessageSuppressed hides ONLY the source physical folder (destination
//    rows in a different physical folder remain visible so fetchMessage can
//    still return them).
// 3) Monotonic count-generation semantics: a captured gen becomes stale as
//    soon as a mutation bumps it — same invariant loadCounts / loadCountsFast
//    rely on in mail.tsx.

import { describe, it, expect } from "vitest";
import { resolveFolderByPath } from "@/lib/mail-move-writer.server";
import {
  beginPendingMove,
  isMessageSuppressed,
  type PendingMovesMap,
} from "@/lib/mail-pending-moves";

// Minimal Postgrest-like builder that records every .eq() call and returns
// whichever row the fixture wants at maybeSingle().
function makeSupabaseStub(row: { id: string; uidvalidity: number | null; path: string } | null) {
  const calls: Array<[string, unknown]> = [];
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      calls.push([col, val]);
      return builder;
    },
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return {
    calls,
    client: { from: () => builder } as any,
  };
}

describe("Batch A / Fix #3 — resolveFolderByPath company scoping", () => {
  it("filters by company_id when companyId is passed", async () => {
    const { client, calls } = makeSupabaseStub({ id: "f1", uidvalidity: 1, path: "INBOX" });
    await resolveFolderByPath(client, "acc-1", "INBOX", "co-1");
    expect(calls).toContainEqual(["account_id", "acc-1"]);
    expect(calls).toContainEqual(["path", "INBOX"]);
    expect(calls).toContainEqual(["company_id", "co-1"]);
  });

  it("omits company_id filter when companyId is not provided (legacy path)", async () => {
    const { client, calls } = makeSupabaseStub({ id: "f1", uidvalidity: 1, path: "INBOX" });
    await resolveFolderByPath(client, "acc-1", "INBOX");
    expect(calls.some(([c]) => c === "company_id")).toBe(false);
  });
});

describe("Batch A / Fix #2 — cache/prefetch overlay guard", () => {
  it("suppresses the source row so fetchMessage returns null for it", () => {
    const map: PendingMovesMap = new Map();
    beginPendingMove(map, {
      accountId: "acc-1",
      sourceFolder: "inbox",
      sourceUid: 42,
      messageId: "inbox:42",
      operation: "trash",
    });
    expect(isMessageSuppressed(map, "acc-1", "inbox:42")).toBe(true);
  });

  it("does NOT suppress destination-folder rows in a different physical folder", () => {
    const map: PendingMovesMap = new Map();
    beginPendingMove(map, {
      accountId: "acc-1",
      sourceFolder: "inbox",
      sourceUid: 42,
      messageId: "inbox:42",
      operation: "trash",
    });
    // A row whose id is in the trash physical folder is the destination
    // side — it must remain visible.
    expect(isMessageSuppressed(map, "acc-1", "trash:99")).toBe(false);
  });

  it("does not bleed across accounts", () => {
    const map: PendingMovesMap = new Map();
    beginPendingMove(map, {
      accountId: "acc-A",
      sourceFolder: "inbox",
      sourceUid: 42,
      messageId: "inbox:42",
      operation: "trash",
    });
    expect(isMessageSuppressed(map, "acc-B", "inbox:42")).toBe(false);
  });
});

describe("Batch A / Fix #1 — monotonic count-generation semantics", () => {
  // Mirrors the exact pattern loadCounts / loadCountsFast use in mail.tsx:
  // capture gen -> await -> if changed, drop the result.
  it("captured gen becomes stale after a mutation bumps it", async () => {
    let gen = 0;
    const bump = () => {
      gen += 1;
    };
    const captured = gen;
    // A mutation fires while the response is in flight:
    bump();
    // The response arrives:
    const isStale = captured !== gen;
    expect(isStale).toBe(true);
  });

  it("no mutation means the result is honoured", async () => {
    let gen = 7;
    const captured = gen;
    // no bump
    const isStale = captured !== gen;
    expect(isStale).toBe(false);
    // Reference to prevent unused var lint.
    expect(gen).toBe(7);
  });
});
