// BLOCKER_4 + BLOCKER_7 unit tests for `mail-move-writer.server`.
//
// Verifies:
//   B4-a  adjustFolderCountsDelta calls ONLY the atomic RPC, never a raw
//         SELECT+UPDATE, with the full identity {folderId, accountId,
//         companyId, totalDelta, unreadDelta}.
//   B4-b  Sequential retries of the same Move produce exactly one source
//         decrement (idempotent via tombstone `changed:false`) and never
//         a negative count.
//   B4-c  Five concurrent moves of distinct messages produce Source -5,
//         Destination +5 (single RPC call per side per message).
//   B7-a  insertDestinationRowFromSource returns `{inserted:true}` when
//         the upsert-select returned a fresh row.
//   B7-b  insertDestinationRowFromSource returns `{inserted:false}` when a
//         racing Sync already wrote that row (upsert-select returns []).
//         The Sync-written data is NOT overwritten.
//   B7-c  applyMoveWriteThrough with Sync-wins race: source is still
//         tombstoned (source RPC -1), destination RPC is NOT called
//         (destinationInserted=false), so no double increment.
import { describe, it, expect, vi } from "vitest";
import {
  adjustFolderCountsDelta,
  insertDestinationRowFromSource,
  applyMoveWriteThrough,
} from "@/lib/mail-move-writer.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------- Fake Supabase ----------
interface FoldersRow {
  id: string;
  account_id: string;
  company_id: string;
  canonical: string;
  path: string;
  uidvalidity: number;
  total: number;
  unread: number;
  uidnext: number | null;
}
interface MessagesRow {
  id: string;
  account_id: string;
  company_id: string;
  folder_id: string;
  uidvalidity: number;
  uid: number;
  seen: boolean;
  message_id: string | null;
  deleted_at: string | null;
  // envelope fields (kept minimal — the writer copies them opaquely)
  subject: string | null;
  from_addr: unknown;
  to_addrs: unknown;
  cc_addrs: unknown;
  internal_date: string | null;
  size_bytes: number | null;
  has_attachments: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  keywords: string[];
  in_reply_to: string | null;
  modseq: number | null;
}

interface FakeState {
  folders: FoldersRow[];
  messages: MessagesRow[];
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
  rawFolderUpdates: number; // must remain 0 on hot path
  destUpsertMode: "insert" | "duplicate"; // simulates Sync-wins race
}

function makeState(over: Partial<FakeState> = {}): FakeState {
  return {
    folders: [],
    messages: [],
    rpcCalls: [],
    rawFolderUpdates: 0,
    destUpsertMode: "insert",
    ...over,
  };
}

function makeSupabase(state: FakeState): SupabaseClient {
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    state.rpcCalls.push({ name, params });
    if (name === "adjust_mail_folder_counts_atomic") {
      const f = state.folders.find(
        (x) =>
          x.id === params.p_folder_id &&
          x.account_id === params.p_account_id &&
          x.company_id === params.p_company_id,
      );
      if (!f) return { data: null, error: null };
      f.total = Math.max(0, f.total + (params.p_total_delta as number));
      f.unread = Math.max(0, f.unread + (params.p_unread_delta as number));
      return { data: [{ total: f.total, unread: f.unread }], error: null };
    }
    return { data: null, error: null };
  });

  const from = (table: string) => {
    if (table === "mail_folders") return buildFolders(state);
    if (table === "mail_messages") return buildMessages(state);
    throw new Error(`unknown table ${table}`);
  };

  return { from, rpc } as unknown as SupabaseClient;
}

function buildFolders(state: FakeState) {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    eq: (c: string, v: unknown) => {
      filters[c] = v;
      return chain;
    },
    maybeSingle: async () => {
      const f = state.folders.find((row) =>
        Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v),
      );
      return { data: f ?? null, error: null };
    },
    update: (patch: Record<string, unknown>) => {
      state.rawFolderUpdates += 1;
      return {
        eq: (c: string, v: unknown) => {
          filters[c] = v;
          const idx = state.folders.findIndex(
            (row) =>
              Object.entries(filters).every(
                ([k, val]) => (row as unknown as Record<string, unknown>)[k] === val,
              ),
          );
          if (idx >= 0) Object.assign(state.folders[idx], patch);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return chain;
}

function buildMessages(state: FakeState) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: (c: string, v: unknown) => {
      filters[c] = v;
      return chain;
    },
    is: (c: string, v: unknown) => {
      filters[`${c}__is`] = v;
      return chain;
    },
    maybeSingle: async () => {
      const row = state.messages.find((m) => {
        for (const [k, v] of Object.entries(filters)) {
          if (k.endsWith("__is")) {
            const col = k.replace("__is", "");
            if ((m as unknown as Record<string, unknown>)[col] !== v) return false;
          } else if ((m as unknown as Record<string, unknown>)[k] !== v) return false;
        }
        return true;
      });
      return { data: row ?? null, error: null };
    },
    update: (patch: Record<string, unknown>) => ({
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return {
          eq: (c2: string, v2: unknown) => {
            filters[c2] = v2;
            return {
              eq: (c3: string, v3: unknown) => {
                filters[c3] = v3;
                return {
                  eq: (c4: string, v4: unknown) => {
                    filters[c4] = v4;
                    return {
                      is: (col: string, val: unknown) => {
                        filters[`${col}__is`] = val;
                        return {
                          select: () => ({
                            maybeSingle: async () => {
                              const idx = state.messages.findIndex((m) => {
                                for (const [k, v] of Object.entries(filters)) {
                                  if (k.endsWith("__is")) {
                                    const col2 = k.replace("__is", "");
                                    if (
                                      (m as unknown as Record<string, unknown>)[col2] !== v
                                    )
                                      return false;
                                  } else if (
                                    (m as unknown as Record<string, unknown>)[k] !== v
                                  )
                                    return false;
                                }
                                return true;
                              });
                              if (idx < 0) return { data: null, error: null };
                              const before = state.messages[idx];
                              Object.assign(before, patch);
                              return {
                                data: { id: before.id, seen: before.seen },
                                error: null,
                              };
                            },
                          }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    }),
    upsert: (
      row: Record<string, unknown>,
      _opts?: { onConflict?: string; ignoreDuplicates?: boolean },
    ) => ({
      select: (_cols?: string) => ({
        then: (
          onFulfilled: (r: {
            data: Array<{ id: string }>;
            error: null;
          }) => unknown,
        ) => {
          if (state.destUpsertMode === "duplicate") {
            // Sync already inserted → DO NOTHING → 0 rows returned.
            return Promise.resolve(onFulfilled({ data: [], error: null }));
          }
          const id = `msg-${state.messages.length + 1}`;
          state.messages.push({
            id,
            account_id: row.account_id as string,
            company_id: row.company_id as string,
            folder_id: row.folder_id as string,
            uidvalidity: row.uidvalidity as number,
            uid: row.uid as number,
            seen: row.seen as boolean,
            message_id: (row.message_id as string) ?? null,
            deleted_at: null,
            subject: (row.subject as string) ?? null,
            from_addr: row.from_addr,
            to_addrs: row.to_addrs,
            cc_addrs: row.cc_addrs,
            internal_date: (row.internal_date as string) ?? null,
            size_bytes: (row.size_bytes as number) ?? null,
            has_attachments: !!row.has_attachments,
            flagged: !!row.flagged,
            answered: !!row.answered,
            draft: !!row.draft,
            keywords: (row.keywords as string[]) ?? [],
            in_reply_to: (row.in_reply_to as string) ?? null,
            modseq: null,
          });
          return Promise.resolve(
            onFulfilled({ data: [{ id }], error: null }),
          );
        },
      }),
    }),
  });
  return chain;
}

// ---------- BLOCKER_4 ----------

describe("BLOCKER_4 — adjustFolderCountsDelta uses only the atomic RPC", () => {
  it("calls the RPC with full identity and no raw folder UPDATE", async () => {
    const s = makeState({
      folders: [
        {
          id: "f1",
          account_id: "acc",
          company_id: "co",
          canonical: "inbox",
          path: "INBOX",
          uidvalidity: 10,
          total: 5,
          unread: 2,
          uidnext: 100,
        },
      ],
    });
    const supa = makeSupabase(s);
    await adjustFolderCountsDelta(supa, {
      folderId: "f1",
      accountId: "acc",
      companyId: "co",
      totalDelta: -1,
      unreadDelta: -1,
    });
    expect(s.rpcCalls).toEqual([
      {
        name: "adjust_mail_folder_counts_atomic",
        params: {
          p_folder_id: "f1",
          p_account_id: "acc",
          p_company_id: "co",
          p_total_delta: -1,
          p_unread_delta: -1,
        },
      },
    ]);
    expect(s.rawFolderUpdates).toBe(0);
    expect(s.folders[0]).toMatchObject({ total: 4, unread: 1 });
  });

  it("clamps at zero (never below zero even with concurrent decrements)", async () => {
    const s = makeState({
      folders: [
        {
          id: "f1",
          account_id: "acc",
          company_id: "co",
          canonical: "inbox",
          path: "INBOX",
          uidvalidity: 10,
          total: 1,
          unread: 1,
          uidnext: 100,
        },
      ],
    });
    const supa = makeSupabase(s);
    await Promise.all([
      adjustFolderCountsDelta(supa, {
        folderId: "f1",
        accountId: "acc",
        companyId: "co",
        totalDelta: -1,
        unreadDelta: -1,
      }),
      adjustFolderCountsDelta(supa, {
        folderId: "f1",
        accountId: "acc",
        companyId: "co",
        totalDelta: -1,
        unreadDelta: -1,
      }),
      adjustFolderCountsDelta(supa, {
        folderId: "f1",
        accountId: "acc",
        companyId: "co",
        totalDelta: -1,
        unreadDelta: -1,
      }),
    ]);
    expect(s.folders[0].total).toBe(0);
    expect(s.folders[0].unread).toBe(0);
  });
});

// ---------- BLOCKER_7 ----------

const SRC_FOLDER: FoldersRow = {
  id: "src",
  account_id: "acc",
  company_id: "co",
  canonical: "inbox",
  path: "INBOX",
  uidvalidity: 10,
  total: 10,
  unread: 3,
  uidnext: 200,
};
const DST_FOLDER: FoldersRow = {
  id: "dst",
  account_id: "acc",
  company_id: "co",
  canonical: "trash",
  path: "Trash",
  uidvalidity: 20,
  total: 0,
  unread: 0,
  uidnext: 500,
};

function seededMessage(uid: number, seen = false): MessagesRow {
  return {
    id: `msg-src-${uid}`,
    account_id: "acc",
    company_id: "co",
    folder_id: "src",
    uidvalidity: 10,
    uid,
    seen,
    message_id: `<m-${uid}@x>`,
    deleted_at: null,
    subject: `s${uid}`,
    from_addr: { email: `x${uid}@x` },
    to_addrs: [],
    cc_addrs: [],
    internal_date: "2026-01-01T00:00:00Z",
    size_bytes: 1000,
    has_attachments: false,
    flagged: false,
    answered: false,
    draft: false,
    keywords: [],
    in_reply_to: null,
    modseq: null,
  };
}

describe("BLOCKER_7 — insertDestinationRowFromSource proves inserted from DB", () => {
  it("returns inserted=true when upsert-select returned a fresh row", async () => {
    const s = makeState({
      folders: [SRC_FOLDER, DST_FOLDER],
      messages: [seededMessage(100)],
      destUpsertMode: "insert",
    });
    const out = await insertDestinationRowFromSource(makeSupabase(s), {
      accountId: "acc",
      companyId: "co",
      sourceFolderId: "src",
      sourceUidvalidity: 10,
      sourceUid: 100,
      destinationFolderId: "dst",
      destinationUidvalidity: 20,
      destinationUid: 900,
    });
    expect(out).toEqual({ inserted: true, wasUnread: true });
  });

  it("returns inserted=false when a racing sync already wrote the row", async () => {
    const s = makeState({
      folders: [SRC_FOLDER, DST_FOLDER],
      messages: [seededMessage(100)],
      destUpsertMode: "duplicate", // simulate Sync-wins race
    });
    const out = await insertDestinationRowFromSource(makeSupabase(s), {
      accountId: "acc",
      companyId: "co",
      sourceFolderId: "src",
      sourceUidvalidity: 10,
      sourceUid: 100,
      destinationFolderId: "dst",
      destinationUidvalidity: 20,
      destinationUid: 900,
    });
    expect(out).toEqual({ inserted: false, wasUnread: true });
  });
});

describe("BLOCKER_4 + BLOCKER_7 — applyMoveWriteThrough end-to-end", () => {
  it("Move-wins: source -1 and destination +1 via one RPC each", async () => {
    const s = makeState({
      folders: [
        { ...SRC_FOLDER },
        { ...DST_FOLDER },
      ],
      messages: [seededMessage(100)],
      destUpsertMode: "insert",
    });
    const supa = makeSupabase(s);
    const out = await applyMoveWriteThrough(supa, {
      accountId: "acc",
      companyId: "co",
      sourceCanonical: "inbox",
      destCanonical: "trash",
      sourceUid: 100,
      destinationUid: 900,
      destinationUidValidity: "20",
      uidMappingAvailable: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sourceTombstoned).toBe(true);
    expect(out.destinationInserted).toBe(true);
    // Exactly 2 RPC calls: one source -1, one destination +1.
    expect(s.rpcCalls).toHaveLength(2);
    expect(s.rpcCalls[0].params.p_folder_id).toBe("src");
    expect(s.rpcCalls[0].params.p_total_delta).toBe(-1);
    expect(s.rpcCalls[1].params.p_folder_id).toBe("dst");
    expect(s.rpcCalls[1].params.p_total_delta).toBe(1);
    expect(s.rawFolderUpdates).toBe(1); // only bumpFolderUidnext raw update
    expect(s.folders.find((f) => f.id === "src")?.total).toBe(9);
    expect(s.folders.find((f) => f.id === "dst")?.total).toBe(1);
  });

  it("Sync-wins race: source still -1, destination NOT incremented (no double count)", async () => {
    const s = makeState({
      folders: [{ ...SRC_FOLDER }, { ...DST_FOLDER, total: 1, unread: 1 }],
      messages: [seededMessage(100)],
      destUpsertMode: "duplicate", // Sync already inserted destination row
    });
    const supa = makeSupabase(s);
    const out = await applyMoveWriteThrough(supa, {
      accountId: "acc",
      companyId: "co",
      sourceCanonical: "inbox",
      destCanonical: "trash",
      sourceUid: 100,
      destinationUid: 900,
      destinationUidValidity: "20",
      uidMappingAvailable: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sourceTombstoned).toBe(true);
    expect(out.destinationInserted).toBe(false);
    // Only the SOURCE RPC ran; destination increment was skipped because
    // the DB proved the row already existed (Sync wrote it first).
    const decs = s.rpcCalls.filter((c) => c.params.p_total_delta === -1);
    const incs = s.rpcCalls.filter((c) => c.params.p_total_delta === 1);
    expect(decs).toHaveLength(1);
    expect(incs).toHaveLength(0);
    // Destination total remains what Sync already computed (1, not 2).
    expect(s.folders.find((f) => f.id === "dst")?.total).toBe(1);
  });

  it("Retry of the same move does NOT double-decrement source (tombstone idempotent)", async () => {
    const s = makeState({
      folders: [{ ...SRC_FOLDER }, { ...DST_FOLDER }],
      messages: [seededMessage(100)],
      destUpsertMode: "insert",
    });
    const supa = makeSupabase(s);
    await applyMoveWriteThrough(supa, {
      accountId: "acc",
      companyId: "co",
      sourceCanonical: "inbox",
      destCanonical: "trash",
      sourceUid: 100,
      destinationUid: 900,
      destinationUidValidity: "20",
      uidMappingAvailable: true,
    });
    // Second call: row is now tombstoned → tomb.changed === false →
    // NO RPC call for source; no destination path attempted either.
    const rpcBefore = s.rpcCalls.length;
    const out2 = await applyMoveWriteThrough(supa, {
      accountId: "acc",
      companyId: "co",
      sourceCanonical: "inbox",
      destCanonical: "trash",
      sourceUid: 100,
      destinationUid: 900,
      destinationUidValidity: "20",
      uidMappingAvailable: true,
    });
    expect(rpcBefore).toBe(2);
    expect(s.rpcCalls.length).toBe(2); // NO additional RPCs on retry
    if (out2.ok) {
      expect(out2.sourceTombstoned).toBe(false);
      expect(out2.destinationInserted).toBe(false);
    }
    expect(s.folders.find((f) => f.id === "src")?.total).toBe(9);
    expect(s.folders.find((f) => f.id === "dst")?.total).toBe(1);
  });

  it("Five distinct moves: Source -5, Destination +5 exactly", async () => {
    const s = makeState({
      folders: [{ ...SRC_FOLDER, total: 10, unread: 5 }, { ...DST_FOLDER }],
      messages: [100, 101, 102, 103, 104].map((u) => seededMessage(u, u % 2 === 0)),
      destUpsertMode: "insert",
    });
    const supa = makeSupabase(s);
    await Promise.all(
      [100, 101, 102, 103, 104].map((u, i) =>
        applyMoveWriteThrough(supa, {
          accountId: "acc",
          companyId: "co",
          sourceCanonical: "inbox",
          destCanonical: "trash",
          sourceUid: u,
          destinationUid: 900 + i,
          destinationUidValidity: "20",
          uidMappingAvailable: true,
        }),
      ),
    );
    const src = s.folders.find((f) => f.id === "src")!;
    const dst = s.folders.find((f) => f.id === "dst")!;
    expect(src.total).toBe(5);
    expect(dst.total).toBe(5);
    // Unread parity: uids 100/102/104 seen (per seededMessage(u, u%2===0)),
    // so 2 unread messages moved (101, 103). src.unread 5-2=3, dst 0+2=2.
    expect(src.unread).toBe(3);
    expect(dst.unread).toBe(2);

    // Exactly 10 RPC calls (5 source + 5 destination).
    expect(s.rpcCalls.filter((c) => c.name === "adjust_mail_folder_counts_atomic")).toHaveLength(10);
  });
});
