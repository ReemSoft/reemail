// Regression tests for the Local Mail Index flag write-through path.
//
// These tests target the pure helpers extracted from `indexUpdateFlag` so
// future refactors that drop write-through, unread recount, or the
// flags_need_reconcile fallback will fail loudly.
import { describe, it, expect, vi } from "vitest";
import {
  resolveFolderForFlag,
  updateMessageFlag,
  recomputeFolderUnread,
  markFolderNeedsFlagReconcile,
} from "../mail-flags-writer.server";

// Minimal chainable Supabase-like mock. Each chained call returns `this` and
// the terminal awaited value comes from `__terminal`, allowing us to script
// per-call outcomes.
function makeChain(terminals: Array<{ data?: unknown; error?: unknown; count?: number }>) {
  const calls: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
  let cursor = 0;
  const client = {
    calls,
    from(table: string) {
      const entry: (typeof calls)[number] = { table, ops: [] };
      calls.push(entry);
      const chain: Record<string, unknown> = {};
      const push =
        (name: string) =>
        (...args: unknown[]) => {
          entry.ops.push([name, ...args]);
          return chain;
        };
      for (const m of ["select", "update", "eq", "is", "maybeSingle"]) chain[m] = push(m);
      // Terminal awaiting — resolved when awaited.
      chain.then = (resolve: (v: unknown) => void) => resolve(terminals[cursor++] ?? {});
      return chain;
    },
  };
  return client as unknown as import("@supabase/supabase-js").SupabaseClient & typeof client;
}

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("resolveFolderForFlag", () => {
  it("returns null when folder is not yet indexed", async () => {
    const sb = makeChain([{ data: null }]);
    const r = await resolveFolderForFlag(sb, ACC, CID, "inbox");
    expect(r).toBeNull();
    expect(sb.calls[0].table).toBe("mail_folders");
  });
  it("returns null when uidvalidity is unset", async () => {
    const sb = makeChain([{ data: { id: FID, uidvalidity: null } }]);
    expect(await resolveFolderForFlag(sb, ACC, CID, "inbox")).toBeNull();
  });
  it("returns {id, uidvalidity} on success and enforces company scoping", async () => {
    const sb = makeChain([{ data: { id: FID, uidvalidity: 42 } }]);
    const r = await resolveFolderForFlag(sb, ACC, CID, "inbox");
    expect(r).toEqual({ id: FID, uidvalidity: 42 });
    // The company_id filter must be present — otherwise a folder from another
    // company could be resolved.
    const eqOps = sb.calls[0].ops.filter(([n]) => n === "eq").map(([, k]) => k);
    expect(eqOps).toContain("company_id");
    expect(eqOps).toContain("account_id");
    expect(eqOps).toContain("canonical");
  });
  it("propagates errors from Supabase", async () => {
    const sb = makeChain([{ error: new Error("db down") }]);
    await expect(resolveFolderForFlag(sb, ACC, CID, "inbox")).rejects.toThrow("db down");
  });
});

describe("updateMessageFlag", () => {
  it("writes seen=true and scopes by account/folder/uidvalidity/uid", async () => {
    const sb = makeChain([{}]);
    await updateMessageFlag(sb, {
      accountId: ACC,
      folderId: FID,
      uidvalidity: 42,
      uid: 7,
      kind: "seen",
      value: true,
    });
    const call = sb.calls[0];
    expect(call.table).toBe("mail_messages");
    const patch = call.ops.find(([n]) => n === "update")?.[1] as Record<string, unknown>;
    expect(patch).toEqual({ seen: true });
    const eqOps = Object.fromEntries(
      call.ops.filter(([n]) => n === "eq").map(([, k, v]) => [k as string, v]),
    );
    expect(eqOps).toEqual({ account_id: ACC, folder_id: FID, uidvalidity: 42, uid: 7 });
  });
  it("writes flagged=false for kind=flagged", async () => {
    const sb = makeChain([{}]);
    await updateMessageFlag(sb, {
      accountId: ACC,
      folderId: FID,
      uidvalidity: 1,
      uid: 1,
      kind: "flagged",
      value: false,
    });
    const patch = sb.calls[0].ops.find(([n]) => n === "update")?.[1] as Record<string, unknown>;
    expect(patch).toEqual({ flagged: false });
  });
  it("throws on Supabase error so caller can trigger reconcile", async () => {
    const sb = makeChain([{ error: new Error("update failed") }]);
    await expect(
      updateMessageFlag(sb, {
        accountId: ACC,
        folderId: FID,
        uidvalidity: 1,
        uid: 1,
        kind: "seen",
        value: true,
      }),
    ).rejects.toThrow("update failed");
  });
});

describe("recomputeFolderUnread", () => {
  it("uses head+count and writes result back to mail_folders.unread", async () => {
    const sb = makeChain([{ count: 3 }, {}]);
    const n = await recomputeFolderUnread(sb, {
      accountId: ACC,
      folderId: FID,
      uidvalidity: 42,
    });
    expect(n).toBe(3);
    // First call: select head+count on mail_messages
    expect(sb.calls[0].table).toBe("mail_messages");
    const selectArgs = sb.calls[0].ops.find(([n]) => n === "select");
    expect(selectArgs).toBeTruthy();
    expect(selectArgs?.[2]).toMatchObject({ count: "exact", head: true });
    // Must filter deleted_at IS NULL and seen=false
    const isOps = sb.calls[0].ops.filter(([n]) => n === "is").map(([, k]) => k);
    expect(isOps).toContain("deleted_at");
    // Second call: update mail_folders
    expect(sb.calls[1].table).toBe("mail_folders");
    const patch = sb.calls[1].ops.find(([n]) => n === "update")?.[1] as Record<string, unknown>;
    expect(patch).toEqual({ unread: 3 });
  });
  it("treats missing count as 0", async () => {
    const sb = makeChain([{ count: undefined }, {}]);
    const n = await recomputeFolderUnread(sb, { accountId: ACC, folderId: FID, uidvalidity: 1 });
    expect(n).toBe(0);
  });
});

describe("markFolderNeedsFlagReconcile", () => {
  it("sets flags_need_reconcile=true on mail_sync_state", async () => {
    const sb = makeChain([{}]);
    await markFolderNeedsFlagReconcile(sb, { accountId: ACC, folderId: FID });
    expect(sb.calls[0].table).toBe("mail_sync_state");
    const patch = sb.calls[0].ops.find(([n]) => n === "update")?.[1] as Record<string, unknown>;
    expect(patch).toEqual({ flags_need_reconcile: true });
    const eqOps = Object.fromEntries(
      sb.calls[0].ops.filter(([n]) => n === "eq").map(([, k, v]) => [k as string, v]),
    );
    expect(eqOps).toEqual({ account_id: ACC, folder_id: FID });
  });
  it("propagates errors so caller can log", async () => {
    const sb = makeChain([{ error: new Error("boom") }]);
    await expect(
      markFolderNeedsFlagReconcile(sb, { accountId: ACC, folderId: FID }),
    ).rejects.toThrow("boom");
  });
});
