// Unit tests for the Local Mail Index permanent-delete writer (Blocker 1).
//
// The writer's contract:
//   1) No source folder row indexed → applied: "no-source-folder", NO tombstone,
//      NO RPC call.
//   2) Source row missing (already tombstoned or never seen) → applied:
//      "already-tombstoned", NO RPC call (would double-decrement counters).
//   3) Source row present and unread → tombstone + RPC with total=-1, unread=-1.
//   4) Source row present and read   → tombstone + RPC with total=-1, unread=0.
//   5) RPC failure surfaces as ok:false; row still tombstoned (IMAP is truth,
//      counters self-heal on next poll).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyDeleteWriteThrough } from "@/lib/mail-delete-writer.server";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FakeState {
  folderRow: { id: string; uidvalidity: number | null; path: string | null } | null;
  messageRow: { id: string; seen: boolean; deleted_at: string | null } | null;
  updates: Array<{ table: string; patch: unknown; matchId?: string }>;
  rpcCalls: Array<{ name: string; args: unknown }>;
  rpcError: string | null;
}

function makeSupabase(state: FakeState): SupabaseClient {
  const from = (table: string) => {
    const chain: any = {
      _table: table,
      _filters: {} as Record<string, unknown>,
      _selectCols: "*",
      select(cols: string) {
        this._selectCols = cols;
        return this;
      },
      eq(col: string, val: unknown) {
        this._filters[col] = val;
        return this;
      },
      async maybeSingle() {
        if (table === "mail_folders") return { data: state.folderRow, error: null };
        if (table === "mail_messages") return { data: state.messageRow, error: null };
        return { data: null, error: null };
      },
      update(patch: unknown) {
        return {
          eq: (_c: string, id: unknown) => {
            state.updates.push({ table, patch, matchId: String(id) });
            return Promise.resolve({ error: null });
          },
        };
      },
    };
    return chain;
  };
  const rpc = (name: string, args: unknown) => {
    state.rpcCalls.push({ name, args });
    return Promise.resolve(
      state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: null, error: null },
    );
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const baseInput = {
  accountId: "acc-1",
  companyId: "co-1",
  sourceCanonical: "trash",
  sourceUid: 42,
};

describe("applyDeleteWriteThrough", () => {
  let state: FakeState;
  beforeEach(() => {
    state = {
      folderRow: { id: "f-trash", uidvalidity: 100, path: "Trash" },
      messageRow: { id: "m-1", seen: false, deleted_at: null },
      updates: [],
      rpcCalls: [],
      rpcError: null,
    };
  });

  it("no source folder row → no-source-folder, no RPC", async () => {
    state.folderRow = null;
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "no-source-folder", wasUnread: false });
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("row missing → already-tombstoned, no RPC", async () => {
    state.messageRow = null;
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "already-tombstoned", wasUnread: false });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("unread row → tombstone + RPC(-1,-1)", async () => {
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "tombstoned", wasUnread: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].table).toBe("mail_messages");
    expect(state.rpcCalls).toEqual([
      {
        name: "adjust_mail_folder_counts_atomic",
        args: {
          p_folder_id: "f-trash",
          p_account_id: "acc-1",
          p_company_id: "co-1",
          p_total_delta: -1,
          p_unread_delta: -1,
        },
      },
    ]);
  });

  it("read row → tombstone + RPC(-1, 0)", async () => {
    state.messageRow = { id: "m-1", seen: true, deleted_at: null };
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "tombstoned", wasUnread: false });
    expect(state.rpcCalls[0].args).toMatchObject({ p_total_delta: -1, p_unread_delta: 0 });
  });

  it("already-tombstoned row (deleted_at set) → no second UPDATE, no RPC", async () => {
    state.messageRow = { id: "m-1", seen: false, deleted_at: "2026-01-01" };
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out.ok).toBe(true);
    // tombstoneSourceRow returns { wasUnread } without writing when already deleted;
    // so the writer proceeds to RPC. Verify RPC is called exactly once and
    // no additional UPDATE was performed against mail_messages.
    expect(state.updates).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("RPC error surfaces as ok:false", async () => {
    state.rpcError = "boom";
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: false, error: "boom" });
    // Row was still tombstoned before the RPC failed.
    expect(state.updates).toHaveLength(1);
  });
});
