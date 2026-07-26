import { describe, it, expect } from "vitest";
import {
  UPSERT_CHUNK,
  computeTombstoneUids,
  mapFlagStateToUpdate,
  mapSyncMessageToRow,
  shouldWipeForUidValidity,
  upsertMessagesInBatches,
  applyFlagStates,
  tombstoneMissingInRange,
  type SyncMessagePayload,
  type SyncFlagStatePayload,
} from "../mail-sync-writer.server";

const ACC = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const FID = "33333333-3333-4333-8333-333333333333";

// ---------------- Pure helpers ----------------

describe("shouldWipeForUidValidity", () => {
  it("first-time adoption is not a wipe", () => {
    expect(shouldWipeForUidValidity(null, "42")).toBe(false);
    expect(shouldWipeForUidValidity(undefined, "42")).toBe(false);
  });
  it("same value is not a wipe", () => {
    expect(shouldWipeForUidValidity("42", "42")).toBe(false);
  });
  it("different value triggers wipe", () => {
    expect(shouldWipeForUidValidity("41", "42")).toBe(true);
  });
  it("compares as strings, not numbers", () => {
    // 20-digit values that would overflow signed bigint arithmetic in JS.
    expect(shouldWipeForUidValidity("99999999999999999999", "99999999999999999999")).toBe(false);
    expect(shouldWipeForUidValidity("99999999999999999999", "99999999999999999998")).toBe(true);
  });
});

describe("computeTombstoneUids", () => {
  it("returns UIDs missing on the server", () => {
    expect(computeTombstoneUids([1, 2, 3, 4, 5], [1, 3, 5])).toEqual([2, 4]);
  });
  it("empty local returns empty", () => {
    expect(computeTombstoneUids([], [1, 2, 3])).toEqual([]);
  });
  it("empty present tombstones everything", () => {
    expect(computeTombstoneUids([7, 8], [])).toEqual([7, 8]);
  });
  it("preserves local order", () => {
    expect(computeTombstoneUids([9, 1, 5, 3], [5])).toEqual([9, 1, 3]);
  });
});

describe("mapSyncMessageToRow", () => {
  const base: SyncMessagePayload = {
    uid: 42,
    modseq: "1000",
    messageId: "<abc@x>",
    inReplyTo: "<parent@x>",
    subject: "hi",
    from: { name: "A", email: "a@x" },
    to: [{ name: "B", email: "b@x" }],
    cc: [],
    internalDate: "2026-01-01T00:00:00.000Z",
    sizeBytes: 1234,
    hasAttachments: true,
    flagSeen: true,
    flagFlagged: false,
    flagAnswered: true,
    flagDraft: false,
    keywords: ["work"],
  };

  it("maps all fields, coercing uidvalidity to number", () => {
    const row = mapSyncMessageToRow(
      { accountId: ACC, companyId: CID, folderId: FID, uidValidity: "17" },
      base,
    );
    expect(row.account_id).toBe(ACC);
    expect(row.company_id).toBe(CID);
    expect(row.folder_id).toBe(FID);
    expect(row.uid).toBe(42);
    expect(row.uidvalidity).toBe(17);
    expect(row.modseq).toBe("1000");
    expect(row.message_id).toBe("<abc@x>");
    expect(row.in_reply_to).toBe("<parent@x>");
    expect(row.subject).toBe("hi");
    expect(row.from_addr).toEqual({ name: "A", email: "a@x" });
    expect(row.to_addrs).toEqual([{ name: "B", email: "b@x" }]);
    expect(row.cc_addrs).toEqual([]);
    expect(row.internal_date).toBe("2026-01-01T00:00:00.000Z");
    expect(row.size_bytes).toBe(1234);
    expect(row.has_attachments).toBe(true);
    expect(row.seen).toBe(true);
    expect(row.flagged).toBe(false);
    expect(row.answered).toBe(true);
    expect(row.draft).toBe(false);
    expect(row.keywords).toEqual(["work"]);
    expect(row.deleted_at).toBeNull();
  });

  it("empty subject becomes null (avoid pointless empty strings in the index)", () => {
    const row = mapSyncMessageToRow(
      { accountId: ACC, companyId: CID, folderId: FID, uidValidity: "1" },
      { ...base, subject: "" },
    );
    expect(row.subject).toBeNull();
  });
});

describe("mapFlagStateToUpdate", () => {
  it("only emits mutable flag columns", () => {
    const s: SyncFlagStatePayload = {
      uid: 7,
      modseq: "9",
      flagSeen: false,
      flagFlagged: true,
      flagAnswered: false,
      flagDraft: true,
      keywords: ["x"],
    };
    const patch = mapFlagStateToUpdate(s);
    expect(patch).toEqual({
      modseq: "9",
      seen: false,
      flagged: true,
      answered: false,
      draft: true,
      keywords: ["x"],
    });
    // uid must not appear — it's a lookup key, not a mutable column.
    expect((patch as Record<string, unknown>).uid).toBeUndefined();
  });
});

// ---------------- Batch upsert / flag apply / tombstones ----------------

/** Chainable mock that captures the last query issued per invocation. */
type Call =
  | { kind: "upsert"; table: string; rows: unknown[]; onConflict: string | undefined }
  | { kind: "update"; table: string; patch: Record<string, unknown>; filters: Record<string, unknown>; count?: number }
  | { kind: "select"; table: string; filters: Record<string, unknown> };

function makeChainAdmin(seed: { uidsInRange?: number[] } = {}) {
  const calls: Call[] = [];
  function tableFn(table: string) {
    const chain: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    let mode: "select" | "update" | "upsert" | null = null;
    let patch: Record<string, unknown> = {};
    let rows: unknown[] = [];
    let onConflict: string | undefined;
    let selectCols: string | undefined;
    let updateCount: number | undefined;

    const promise = {
      then(resolve: (v: unknown) => void) {
        if (mode === "select") {
          calls.push({ kind: "select", table, filters: { ...filters } });
          const data = (seed.uidsInRange ?? []).map((u) => ({ uid: u }));
          resolve({ data, error: null });
          return;
        }
        if (mode === "update") {
          calls.push({
            kind: "update",
            table,
            patch,
            filters: { ...filters },
            count: updateCount,
          });
          resolve({ data: null, error: null, count: updateCount ?? 1 });
          return;
        }
        if (mode === "upsert") {
          calls.push({ kind: "upsert", table, rows, onConflict });
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: null, error: null });
      },
    };

    chain.select = (cols?: string) => {
      selectCols = cols;
      mode = "select";
      return chain;
    };
    chain.upsert = (r: unknown[], opts?: { onConflict?: string }) => {
      mode = "upsert";
      rows = r;
      onConflict = opts?.onConflict;
      return chain;
    };
    chain.update = (p: Record<string, unknown>, opts?: { count?: string }) => {
      mode = "update";
      patch = p;
      updateCount = opts?.count === "exact" ? 1 : undefined;
      return Object.assign(chain, promise);
    };
    chain.eq = (col: string, val: unknown) => {
      filters[`eq:${col}`] = val;
      return Object.assign(chain, promise);
    };
    chain.gte = (col: string, val: unknown) => {
      filters[`gte:${col}`] = val;
      return Object.assign(chain, promise);
    };
    chain.lte = (col: string, val: unknown) => {
      filters[`lte:${col}`] = val;
      return Object.assign(chain, promise);
    };
    chain.in = (col: string, arr: unknown[]) => {
      filters[`in:${col}`] = arr;
      return Object.assign(chain, promise);
    };
    chain.is = (col: string, val: unknown) => {
      filters[`is:${col}`] = val;
      return Object.assign(chain, promise);
    };
    chain.limit = () => Object.assign(chain, promise);
    chain.maybeSingle = async () => ({ data: null, error: null });
    // Selectcols consumed but not returned for now.
    void selectCols;

    return chain;
  }

  const admin = { from: tableFn } as unknown as Parameters<typeof upsertMessagesInBatches>[0];
  return { admin, calls };
}

describe("upsertMessagesInBatches", () => {
  it("chunks into batches of UPSERT_CHUNK", async () => {
    const { admin, calls } = makeChainAdmin();
    const messages: SyncMessagePayload[] = Array.from({ length: UPSERT_CHUNK * 2 + 5 }, (_, i) => ({
      uid: i + 1,
      modseq: null,
      messageId: null,
      inReplyTo: null,
      subject: `s${i}`,
      from: null,
      to: [],
      cc: [],
      internalDate: "2026-01-01T00:00:00.000Z",
      sizeBytes: null,
      hasAttachments: false,
      flagSeen: false,
      flagFlagged: false,
      flagAnswered: false,
      flagDraft: false,
      keywords: [],
    }));
    const wrote = await upsertMessagesInBatches(
      admin,
      { accountId: ACC, companyId: CID, folderId: FID, uidValidity: "5" },
      messages,
    );
    expect(wrote).toBe(messages.length);
    const upserts = calls.filter((c) => c.kind === "upsert");
    expect(upserts).toHaveLength(3);
    expect((upserts[0] as { rows: unknown[] }).rows).toHaveLength(UPSERT_CHUNK);
    expect((upserts[2] as { rows: unknown[] }).rows).toHaveLength(5);
    for (const u of upserts) {
      expect((u as { onConflict?: string }).onConflict).toBe(
        "account_id,folder_id,uidvalidity,uid",
      );
    }
  });

  it("zero messages issues no queries", async () => {
    const { admin, calls } = makeChainAdmin();
    const wrote = await upsertMessagesInBatches(
      admin,
      { accountId: ACC, companyId: CID, folderId: FID, uidValidity: "5" },
      [],
    );
    expect(wrote).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("applyFlagStates", () => {
  it("emits one scoped UPDATE per state", async () => {
    const { admin, calls } = makeChainAdmin();
    const states: SyncFlagStatePayload[] = [
      { uid: 1, modseq: "1", flagSeen: true, flagFlagged: false, flagAnswered: false, flagDraft: false, keywords: [] },
      { uid: 2, modseq: "2", flagSeen: false, flagFlagged: true, flagAnswered: false, flagDraft: false, keywords: ["k"] },
    ];
    const n = await applyFlagStates(
      admin,
      { accountId: ACC, folderId: FID, uidValidity: "5" },
      states,
    );
    expect(n).toBe(2);
    const updates = calls.filter((c) => c.kind === "update");
    expect(updates).toHaveLength(2);
    expect((updates[0] as { filters: Record<string, unknown> }).filters["eq:uid"]).toBe(1);
    expect((updates[1] as { filters: Record<string, unknown> }).filters["eq:uid"]).toBe(2);
    for (const u of updates) {
      const f = (u as { filters: Record<string, unknown> }).filters;
      expect(f["eq:account_id"]).toBe(ACC);
      expect(f["eq:folder_id"]).toBe(FID);
      expect(f["eq:uidvalidity"]).toBe(5);
    }
  });
});

describe("tombstoneMissingInRange", () => {
  it("marks only UIDs absent from presentUids as deleted_at=now", async () => {
    const { admin, calls } = makeChainAdmin({ uidsInRange: [1, 2, 3, 4, 5] });
    const n = await tombstoneMissingInRange(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "5",
      fromUid: 1,
      toUid: 5,
      presentUids: [2, 4],
    });
    expect(n).toBe(3);
    const updates = calls.filter((c) => c.kind === "update");
    expect(updates).toHaveLength(1);
    const u = updates[0] as { patch: Record<string, unknown>; filters: Record<string, unknown> };
    expect(typeof u.patch.deleted_at).toBe("string");
    // Filter must be scoped to the missing UIDs only.
    expect(u.filters["in:uid"]).toEqual([1, 3, 5]);
    // Range read was properly bounded.
    const selects = calls.filter((c) => c.kind === "select");
    expect(selects).toHaveLength(1);
    const s = selects[0] as { filters: Record<string, unknown> };
    expect(s.filters["gte:uid"]).toBe(1);
    expect(s.filters["lte:uid"]).toBe(5);
    expect(s.filters["is:deleted_at"]).toBeNull();
  });

  it("returns 0 and issues no update when nothing is missing", async () => {
    const { admin, calls } = makeChainAdmin({ uidsInRange: [1, 2, 3] });
    const n = await tombstoneMissingInRange(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "5",
      fromUid: 1,
      toUid: 3,
      presentUids: [1, 2, 3],
    });
    expect(n).toBe(0);
    expect(calls.filter((c) => c.kind === "update")).toHaveLength(0);
  });
});
