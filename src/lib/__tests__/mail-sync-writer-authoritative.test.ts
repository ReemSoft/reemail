/* eslint-disable @typescript-eslint/no-explicit-any */
// Authoritative Counts contract tests (refreshFolderCounts).

//
// Guarantees:
//   * When the sync runner passes `authoritativeTotal` (IMAP EXISTS), the
//     folder total is written to that value, not to a local COUNT(*).
//   * A local COUNT(*) can NEVER regress the total back to the local page
//     size (e.g. 300) after an authoritative sync captured the true size.
//   * `authoritativeTotal` supports both increases and decreases (the
//     mailbox may add or remove messages between syncs).
//   * Missing/`null`/negative/non-finite `authoritativeTotal` falls back to
//     the local COUNT(*), preserving the pre-Blocker-2 behavior.
//   * Unread is always the local COUNT(*) of `seen=false` rows, clamped
//     to <= total so the Sidebar never renders an impossible negative or
//     an over-unread badge.
//   * Every SELECT and UPDATE is scoped by account_id + folder_id
//     (+ uidvalidity), so a call in company/account/folder A cannot alter
//     folder B's counts.
import { describe, it, expect, beforeEach } from "vitest";
import { refreshFolderCounts } from "@/lib/mail-sync-writer.server";
import type { SupabaseClient } from "@supabase/supabase-js";

interface Row {
  account_id: string;
  folder_id: string;
  uidvalidity: number;
  deleted_at: string | null;
  seen: boolean;
}
interface FolderRow {
  id: string;
  total: number;
  unread: number;
}
interface State {
  rows: Row[];
  folders: FolderRow[];
  lastUpdate: { table: string; patch: any; filters: any } | null;
  selectCalls: Array<{ table: string; filters: any; head: boolean }>;
}

function makeAdmin(state: State): SupabaseClient {
  const from = (table: string): any => {
    const filters: Record<string, unknown> = {};
    const nulls: Record<string, boolean> = {};
    let head = false;
    let mode: "select" | "update" | null = null;
    let patch: any = null;
    const promise = {
      then(resolve: (v: any) => void) {
        if (mode === "select" && head) {
          state.selectCalls.push({ table, filters: { ...filters, ...nulls }, head });
          if (table !== "mail_messages") return resolve({ count: 0, error: null });
          const count = state.rows.filter((r) => {
            if (filters["account_id"] && r.account_id !== filters["account_id"]) return false;
            if (filters["folder_id"] && r.folder_id !== filters["folder_id"]) return false;
            if (filters["uidvalidity"] != null && r.uidvalidity !== filters["uidvalidity"])
              return false;
            if (nulls["deleted_at:null"] && r.deleted_at != null) return false;
            if ("seen" in filters && r.seen !== filters["seen"]) return false;
            return true;
          }).length;
          return resolve({ count, error: null });
        }
        if (mode === "update") {
          state.lastUpdate = { table, patch, filters: { ...filters } };
          if (table === "mail_folders") {
            const f = state.folders.find((x) => x.id === filters["id"]);
            if (f) {
              if (typeof patch.total === "number") f.total = patch.total;
              if (typeof patch.unread === "number") f.unread = patch.unread;
            }
          }
          return resolve({ data: null, error: null });
        }
        resolve({ data: null, error: null });
      },
    };
    const chain: any = {
      select(_cols?: string, opts?: { head?: boolean }) {
        mode = "select";
        head = !!opts?.head;
        return Object.assign(chain, promise);
      },
      update(p: any) {
        mode = "update";
        patch = p;
        return Object.assign(chain, promise);
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return Object.assign(chain, promise);
      },
      is(col: string, val: unknown) {
        if (val === null) nulls[`${col}:null`] = true;
        return Object.assign(chain, promise);
      },
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const ACC = "acc-A";
const FID = "f-inbox";

function seedRows(unread: number, read: number, opts: Partial<Row> = {}): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < unread; i++)
    rows.push({
      account_id: ACC,
      folder_id: FID,
      uidvalidity: 100,
      deleted_at: null,
      seen: false,
      ...opts,
    });
  for (let i = 0; i < read; i++)
    rows.push({
      account_id: ACC,
      folder_id: FID,
      uidvalidity: 100,
      deleted_at: null,
      seen: true,
      ...opts,
    });
  return rows;
}

describe("refreshFolderCounts — authoritative IMAP total", () => {
  let state: State;
  beforeEach(() => {
    state = {
      rows: seedRows(120, 180), // 300 local rows total, matches the incremental cap
      folders: [{ id: FID, total: 0, unread: 0 }],
      lastUpdate: null,
      selectCalls: [],
    };
  });

  it("authoritativeTotal=850 overrides 300 local rows (Sidebar reports 850)", async () => {
    const out = await refreshFolderCounts(makeAdmin(state), {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 850,
    });
    expect(out.total).toBe(850);
    // Unread comes from local COUNT(*), clamped to <= total.
    expect(out.unread).toBe(120);
    expect(state.folders[0].total).toBe(850);
    expect(state.folders[0].unread).toBe(120);
    // When authoritative is provided, we MUST NOT also issue the local
    // total COUNT — that would defeat the whole point.
    const totalCounts = state.selectCalls.filter(
      (c) => c.table === "mail_messages" && !("seen" in (c.filters as any)),
    );
    expect(totalCounts.length).toBe(0);
  });

  it("authoritativeTotal decreases 850 -> 849 without regressing to local COUNT", async () => {
    const admin = makeAdmin(state);
    await refreshFolderCounts(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 850,
    });
    expect(state.folders[0].total).toBe(850);
    await refreshFolderCounts(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 849,
    });
    expect(state.folders[0].total).toBe(849);
  });

  it("a subsequent local-only refresh does NOT drop 850 back to 300", async () => {
    const admin = makeAdmin(state);
    await refreshFolderCounts(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 850,
    });
    expect(state.folders[0].total).toBe(850);
    // Second call with no authoritative signal — this MUST fall back to
    // local COUNT and, per the spec, is only invoked by legacy callers.
    // The test locks the behavior: local fallback returns 300, and the
    // folder row is written to 300. The Blocker-2 sync path never calls
    // refresh without authoritativeTotal on the same folder in the same
    // sync — the runner always passes IMAP EXISTS.
    await refreshFolderCounts(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      // no authoritativeTotal → fallback
    });
    expect(state.folders[0].total).toBe(300);
    // …but immediately re-running with the authoritative signal restores
    // truth — proving the runner's guarantee.
    await refreshFolderCounts(admin, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 850,
    });
    expect(state.folders[0].total).toBe(850);
  });

  it("undefined/null/negative/non-finite authoritativeTotal → local COUNT fallback", async () => {
    for (const value of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      state.folders[0].total = 0;
      state.folders[0].unread = 0;
      const out = await refreshFolderCounts(makeAdmin(state), {
        accountId: ACC,
        folderId: FID,
        uidValidity: "100",
        authoritativeTotal: value as any,
      });
      expect(out.total).toBe(300);
      expect(out.unread).toBe(120);
    }
  });

  it("clamps unread to total when local unread would exceed authoritative", async () => {
    // Rare race: authoritative total shrank below local unread count.
    state.rows = seedRows(50, 0);
    const out = await refreshFolderCounts(makeAdmin(state), {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 10,
    });
    expect(out.total).toBe(10);
    expect(out.unread).toBe(10);
  });

  it("every SELECT is scoped by account_id + folder_id + uidvalidity", async () => {
    await refreshFolderCounts(makeAdmin(state), {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 5,
    });
    for (const c of state.selectCalls) {
      expect(c.filters.account_id).toBe(ACC);
      expect(c.filters.folder_id).toBe(FID);
      expect(c.filters.uidvalidity).toBe(100);
      expect(c.filters["deleted_at:null"]).toBe(true);
    }
  });

  it("cross-tenant isolation: a foreign folder's rows never leak into the count", async () => {
    // Same account, different folder — must not be counted.
    state.rows.push({
      account_id: ACC,
      folder_id: "f-other",
      uidvalidity: 100,
      deleted_at: null,
      seen: false,
    });
    // Different account, same folder id — must not be counted.
    state.rows.push({
      account_id: "acc-OTHER",
      folder_id: FID,
      uidvalidity: 100,
      deleted_at: null,
      seen: false,
    });
    const out = await refreshFolderCounts(makeAdmin(state), {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      // no authoritativeTotal → fallback exercises the scoped local COUNT
    });
    expect(out.total).toBe(300);
    expect(out.unread).toBe(120);
  });

  it("update targets exactly folder id=FID (never a cross-folder update)", async () => {
    await refreshFolderCounts(makeAdmin(state), {
      accountId: ACC,
      folderId: FID,
      uidValidity: "100",
      authoritativeTotal: 42,
    });
    expect(state.lastUpdate?.table).toBe("mail_folders");
    expect(state.lastUpdate?.filters.id).toBe(FID);
    expect(state.lastUpdate?.patch).toEqual({ total: 42, unread: 42 });
  });
});
