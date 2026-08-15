// Canonical self-heal (MAILMAESTRO_CANONICAL_SELFHEAL) regression tests.
//
// `ensureFolderRow` must converge a physical folder row's `canonical` to the
// correct logical value ONLY when the caller's (path, canonical) pairing is
// trusted, and must never steal a canonical from a row whose physical path is
// not fully trusted. It must never touch uidvalidity, cursors, messages or
// counts, and must never delete rows.
import { describe, it, expect } from "vitest";
import { ensureFolderRow } from "../mail-sync-writer.server";

type Terminal = { data?: unknown; error?: unknown };

function makeChain(terminals: Terminal[]) {
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
      for (const m of ["select", "update", "insert", "eq", "is", "maybeSingle", "limit"])
        chain[m] = push(m);
      chain.then = (resolve: (v: unknown) => void) => resolve(terminals[cursor++] ?? {});
      return chain;
    },
  };
  return client as unknown as import("@supabase/supabase-js").SupabaseClient & typeof client;
}

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFTS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TRASH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function args(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACC,
    companyId: CID,
    path: "Drafts",
    canonical: "drafts",
    trustedCanonical: true,
    ...overrides,
  };
}

describe("ensureFolderRow canonical self-heal", () => {
  it("repairs a trusted stale canonical (Drafts mislabelled trash → drafts)", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: "trash" } }, // select
      {}, // update canonical
    ]);
    const res = await ensureFolderRow(sb, args({ path: "Drafts", canonical: "drafts", trustedCanonical: true }));

    expect(res.folderId).toBe(DRAFTS_ID);
    expect(res.storedUidValidity).toBe("1000");

    const upd = sb.calls.find(
      (c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"),
    );
    expect(upd).toBeTruthy();
    const payload = upd!.ops.find(([n]) => n === "update")?.[1] as Record<string, unknown>;
    expect(payload.canonical).toBe("drafts");
    // Scoped to id + account + company.
    const eqVals = upd!.ops.filter(([n]) => n === "eq").map((op) => op[2]);
    expect(eqVals).toContain(DRAFTS_ID);
    expect(eqVals).toContain(ACC);
    expect(eqVals).toContain(CID);
  });

  it("does NOT steal canonical from a real Trash row (same canonical already)", async () => {
    const sb = makeChain([
      { data: { id: TRASH_ID, uidvalidity: 2000, canonical: "trash" } }, // select
    ]);
    const res = await ensureFolderRow(
      sb,
      args({ path: "Trash", canonical: "trash", trustedCanonical: true }),
    );
    expect(res.folderId).toBe(TRASH_ID);
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(upd).toBeUndefined();
  });

  it("repairs only the Drafts row, leaving an unrelated real Trash row untouched", async () => {
    // Drafts row is mislabelled trash; real Trash row (different path) stays trash.
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: "trash" } }, // drafts select
      {}, // drafts update
    ]);
    await ensureFolderRow(sb, args({ path: "Drafts", canonical: "drafts", trustedCanonical: true }));

    const updates = sb.calls.filter((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(updates).toHaveLength(1);
    const eqVals = updates[0].ops.filter(([n]) => n === "eq").map((op) => op[2]);
    expect(eqVals).toContain(DRAFTS_ID);
    // No update targeted the Trash row id.
    expect(eqVals).not.toContain(TRASH_ID);
  });

  it("repairs Spam mislabelled trash → spam", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: "trash" } },
      {},
    ]);
    await ensureFolderRow(sb, args({ path: "Junk", canonical: "spam", trustedCanonical: true }));
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    const payload = upd!.ops.find(([n]) => n === "update")?.[1] as Record<string, unknown>;
    expect(payload.canonical).toBe("spam");
  });

  it("repairs a NULL canonical when trusted", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: null } },
      {},
    ]);
    await ensureFolderRow(sb, args({ canonical: "drafts", trustedCanonical: true }));
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(upd).toBeTruthy();
  });

  it("does NOT repair a NULL canonical when NOT trusted (remains NULL)", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: null } },
    ]);
    await ensureFolderRow(sb, args({ canonical: "drafts", trustedCanonical: false }));
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(upd).toBeUndefined();
  });

  it("performs zero UPDATE when the canonical is already correct", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: "drafts" } },
    ]);
    await ensureFolderRow(sb, args({ canonical: "drafts", trustedCanonical: true }));
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(upd).toBeUndefined();
  });

  it("never overwrites an existing canonical when caller canonical is null", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 1000, canonical: "trash" } },
    ]);
    await ensureFolderRow(sb, args({ canonical: null, trustedCanonical: true }));
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(upd).toBeUndefined();
  });

  it("never overwrites an existing non-null canonical when NOT trusted (does not steal)", async () => {
    // Existing real Trash row; an untrusted caller claims "drafts" for this path.
    const sb = makeChain([
      { data: { id: TRASH_ID, uidvalidity: 2000, canonical: "trash" } },
    ]);
    await ensureFolderRow(sb, args({ path: "Trash", canonical: "drafts", trustedCanonical: false }));
    const upd = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    expect(upd).toBeUndefined();
  });

  it("preserves uidvalidity and never touches mail_messages / sync state", async () => {
    const sb = makeChain([
      { data: { id: DRAFTS_ID, uidvalidity: 12345, canonical: "trash" } },
      {},
    ]);
    const res = await ensureFolderRow(sb, args({ canonical: "drafts", trustedCanonical: true }));
    expect(res.storedUidValidity).toBe("12345");
    // Only mail_folders is touched.
    expect(sb.calls.every((c) => c.table === "mail_folders")).toBe(true);
  });

  it("inserts a new row with the caller canonical when no row exists (trusted)", async () => {
    const sb = makeChain([
      { data: null }, // select (miss)
      { data: { id: DRAFTS_ID, uidvalidity: null } }, // insert .select()
    ]);
    const res = await ensureFolderRow(sb, args({ canonical: "drafts", trustedCanonical: true }));
    expect(res.folderId).toBe(DRAFTS_ID);
    const ins = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "insert"));
    expect(ins).toBeTruthy();
    const payload = ins!.ops.find(([n]) => n === "insert")?.[1] as Record<string, unknown>;
    expect(payload.canonical).toBe("drafts");
  });

  it("does NOT persist an untrusted canonical on a new row (persists NULL)", async () => {
    const sb = makeChain([
      { data: null }, // select (miss)
      { data: { id: DRAFTS_ID, uidvalidity: null } }, // insert .select()
    ]);
    await ensureFolderRow(sb, args({ canonical: "trash", trustedCanonical: false }));
    const ins = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "insert"));
    expect(ins).toBeTruthy();
    const payload = ins!.ops.find(([n]) => n === "insert")?.[1] as Record<string, unknown>;
    expect(payload.canonical).toBeNull();
  });
});
