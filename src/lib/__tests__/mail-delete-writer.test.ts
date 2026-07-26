// Unit tests for the Local Mail Index permanent-delete writer (Blocker 1).
//
// Contract exercised:
//   1) No source folder row indexed → "no-source-folder", no RPC, no writes.
//   2) Conditional UPDATE matches 0 rows (missing OR already tombstoned) →
//      "already-tombstoned", NO RPC — idempotency guarantee that fixes the
//      duplicate-decrement bug caught in FIX_BLOCKER_1 review.
//   3) Conditional UPDATE matches 1 row → tombstone + RPC exactly once,
//      with unread delta driven by the row's `seen` flag.
//   4) Two concurrent callers → only ONE RPC decrement (fake DB models the
//      Postgres `WHERE deleted_at IS NULL` serialization).
//   5) RPC failure surfaces as ok:false; row still tombstoned.
import { describe, it, expect, beforeEach } from "vitest";
import { applyDeleteWriteThrough } from "@/lib/mail-delete-writer.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Fake DB modeling the ONE row we care about + its `deleted_at` gate.
interface Row {
  id: string;
  seen: boolean;
  deleted_at: string | null;
}
interface FakeState {
  folderRow: { id: string; uidvalidity: number | null; path: string | null } | null;
  row: Row | null; // null → missing entirely
  updates: number;
  rpcCalls: Array<{ name: string; args: any }>;
  rpcError: string | null;
}

function makeSupabase(state: FakeState): SupabaseClient {
  const from = (table: string): any => {
    const ctx: any = {
      _filters: {} as Record<string, unknown>,
      _isNull: null as string | null,
      select() {
        return this;
      },
      eq(col: string, val: unknown) {
        this._filters[col] = val;
        return this;
      },
      is(col: string, val: unknown) {
        if (val === null) this._isNull = col;
        return this;
      },
      async maybeSingle() {
        if (table === "mail_folders") return { data: state.folderRow, error: null };
        return { data: null, error: null };
      },
      update(patch: Record<string, unknown>) {
        // Return a builder that awaits to the conditional-UPDATE result.
        const b: any = {
          _filters: {} as Record<string, unknown>,
          _isNull: null as string | null,
          eq(col: string, val: unknown) {
            this._filters[col] = val;
            return this;
          },
          is(col: string, val: unknown) {
            if (val === null) this._isNull = col;
            return this;
          },
          select() {
            return this;
          },
          async maybeSingle() {
            if (table !== "mail_messages") return { data: null, error: null };
            // Simulate atomic conditional UPDATE: match only if
            // deleted_at IS NULL currently.
            if (!state.row) return { data: null, error: null };
            if (this._isNull === "deleted_at" && state.row.deleted_at != null) {
              return { data: null, error: null };
            }
            state.row.deleted_at = String(patch.deleted_at ?? new Date().toISOString());
            state.updates++;
            return { data: { id: state.row.id, seen: state.row.seen }, error: null };
          },
        };
        return b;
      },
    };
    return ctx;
  };
  const rpc = (name: string, args: unknown) => {
    state.rpcCalls.push({ name, args });
    return Promise.resolve(
      state.rpcError
        ? { data: null, error: { message: state.rpcError } }
        : { data: null, error: null },
    );
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const baseInput = {
  accountId: "acc-1",
  companyId: "co-1",
  sourceCanonical: "trash" as const,
  sourceUid: 42,
};

describe("applyDeleteWriteThrough (idempotent)", () => {
  let state: FakeState;
  beforeEach(() => {
    state = {
      folderRow: { id: "f-trash", uidvalidity: 100, path: "Trash" },
      row: { id: "m-1", seen: false, deleted_at: null },
      updates: 0,
      rpcCalls: [],
      rpcError: null,
    };
  });

  it("no source folder row → no-source-folder, no RPC, no update", async () => {
    state.folderRow = null;
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "no-source-folder", wasUnread: false });
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.updates).toBe(0);
  });

  it("row missing → already-tombstoned, NO RPC, NO update", async () => {
    state.row = null;
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "already-tombstoned", wasUnread: false });
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.updates).toBe(0);
  });

  it("row already tombstoned → already-tombstoned, NO RPC, NO update", async () => {
    state.row = { id: "m-1", seen: false, deleted_at: "2026-01-01T00:00:00Z" };
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "already-tombstoned", wasUnread: false });
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.updates).toBe(0);
  });

  it("unread row → tombstone + RPC(-1,-1) exactly once", async () => {
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "tombstoned", wasUnread: true });
    expect(state.updates).toBe(1);
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
    state.row = { id: "m-1", seen: true, deleted_at: null };
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: true, applied: "tombstoned", wasUnread: false });
    expect(state.rpcCalls[0].args).toMatchObject({ p_total_delta: -1, p_unread_delta: 0 });
  });

  it("calling twice in sequence → second call is a no-op (RPC still =1)", async () => {
    const supabase = makeSupabase(state);
    const first = await applyDeleteWriteThrough(supabase, baseInput);
    expect(first).toMatchObject({ ok: true, applied: "tombstoned" });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.updates).toBe(1);

    const second = await applyDeleteWriteThrough(supabase, baseInput);
    expect(second).toMatchObject({ ok: true, applied: "already-tombstoned" });
    expect(state.rpcCalls).toHaveLength(1); // no additional RPC
    expect(state.updates).toBe(1); // no additional update
  });

  it("two concurrent callers → RPC decrement called exactly once", async () => {
    const supabase = makeSupabase(state);
    const [a, b] = await Promise.all([
      applyDeleteWriteThrough(supabase, baseInput),
      applyDeleteWriteThrough(supabase, baseInput),
    ]);
    const applied = [a, b].map((r) => (r.ok ? r.applied : "err")).sort();
    expect(applied).toEqual(["already-tombstoned", "tombstoned"]);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.updates).toBe(1);
  });

  it("RPC error surfaces as ok:false; row is still tombstoned", async () => {
    state.rpcError = "boom";
    const out = await applyDeleteWriteThrough(makeSupabase(state), baseInput);
    expect(out).toEqual({ ok: false, error: "boom" });
    expect(state.updates).toBe(1);
    expect(state.row?.deleted_at).not.toBeNull();
  });
});
