// Regression tests for the Draft Local Index write-through (MAILMAESTRO_DRAFTS_V4).
//
// IMAP is authoritative: a projection write must (a) insert the canonical row
// once, (b) tombstone the prior projected UID, and (c) bump the folder count
// exactly once per inserted row — and never throw for a missing UID.
import { describe, it, expect } from "vitest";
import { tombstoneDraftProjection, writeDraftProjection } from "../mail-draft-writer.server";

type Terminal = { data?: unknown; error?: unknown; count?: number };

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
      for (const m of [
        "select",
        "update",
        "insert",
        "upsert",
        "eq",
        "is",
        "maybeSingle",
        "limit",
      ])
        chain[m] = push(m);
      chain.then = (resolve: (v: unknown) => void) => resolve(terminals[cursor++] ?? {});
      return chain;
    },
    rpc(_fn: string, _args: unknown) {
      const entry: { table: string; ops: Array<[string, ...unknown[]]> } = {
        table: "rpc",
        ops: [["rpc", _fn, _args]],
      };
      calls.push(entry);
      const chain: Record<string, unknown> = {};
      chain.then = (resolve: (v: unknown) => void) => resolve(terminals[cursor++] ?? {});
      return chain;
    },
  };
  return client as unknown as import("@supabase/supabase-js").SupabaseClient & typeof client;
}

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACC,
    companyId: CID,
    folderPath: "Drafts",
    uid: 100,
    uidValidity: "1000",
    messageId: "<draft@example.com>",
    subject: "hello",
    from: { name: "Me", email: "me@example.com" },
    to: [{ name: "You", email: "you@example.com" }],
    cc: [],
    internalDate: "2026-01-01T00:00:00.000Z",
    hasAttachments: false,
    previousRef: null,
    ...overrides,
  };
}

describe("writeDraftProjection", () => {
  it("short-circuits without touching the DB when uid is null", async () => {
    const sb = makeChain([]);
    await writeDraftProjection(sb, baseInput({ uid: null }));
    expect(sb.calls).toHaveLength(0);
  });

  it("short-circuits without touching the DB when uidValidity is invalid", async () => {
    const sb = makeChain([]);
    await writeDraftProjection(sb, baseInput({ uidValidity: "" }));
    expect(sb.calls).toHaveLength(0);
  });

  it("first save: inserts the canonical row and bumps the draft count +1 exactly once", async () => {
    const sb = makeChain([
      { data: { id: FID, uidvalidity: 1000, canonical: "drafts" } }, // ensureFolderRow select (exists)
      { data: [{ id: "row1" }] }, // upsert .select()
      { data: true }, // rpc adjustFolderCountsDelta (+1)
    ]);
    await writeDraftProjection(sb, baseInput());

    const folderCall = sb.calls.find((c) => c.table === "mail_folders");
    expect(folderCall).toBeTruthy();

    const upsertCall = sb.calls.find((c) => c.table === "mail_messages" && c.ops.some(([n]) => n === "upsert"));
    expect(upsertCall).toBeTruthy();
    const row = upsertCall!.ops.find(([n]) => n === "upsert")?.[1] as Record<string, unknown>;
    expect(row.draft).toBe(true);
    expect(row.uid).toBe(100);
    expect(row.uidvalidity).toBe(1000);

    const rpcCall = sb.calls.find((c) => c.table === "rpc");
    expect(rpcCall).toBeTruthy();
    const args = rpcCall!.ops[0][2] as Record<string, number>;
    expect(args.p_total_delta).toBe(1);
  });

  it("replacement: tombstones the previous projected UID (net count 0)", async () => {
    const sb = makeChain([
      { data: { id: FID, uidvalidity: 1000, canonical: "drafts" } }, // ensureFolderRow select
      { data: { id: "old", seen: true } }, // tombstoneSourceRow .select() -> changed
      { data: true }, // rpc adjust (-1)
      { data: [{ id: "row2" }] }, // upsert .select()
      { data: true }, // rpc adjust (+1)
    ]);
    await writeDraftProjection(
      sb,
      baseInput({ previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" } }),
    );

    const rpcDeltas = sb.calls
      .filter((c) => c.table === "rpc")
      .map((c) => (c.ops[0][2] as Record<string, number>).p_total_delta);
    expect(rpcDeltas).toEqual([-1, 1]);
  });

  it("does not tombstone a previousRef from another folder or uidvalidity", async () => {
    const sb = makeChain([
      { data: { id: FID, uidvalidity: 1000, canonical: "drafts" } }, // ensureFolderRow select
      { data: [{ id: "row3" }] }, // upsert .select()
      { data: true }, // rpc adjust (+1)
    ]);
    await writeDraftProjection(
      sb,
      baseInput({ previousRef: { folderPath: "INBOX", uid: 42, uidValidity: "999" } }),
    );
    // No tombstone (no -1) — only the insert +1.
    const rpcDeltas = sb.calls
      .filter((c) => c.table === "rpc")
      .map((c) => (c.ops[0][2] as Record<string, number>).p_total_delta);
    expect(rpcDeltas).toEqual([1]);
  });
});

describe("tombstoneDraftProjection", () => {
  function delInput(overrides: Record<string, unknown> = {}) {
    return {
      accountId: ACC,
      companyId: CID,
      folderPath: "Drafts",
      uid: 100,
      uidValidity: "1000",
      ...overrides,
    };
  }

  it("tombstones a live projected row and decrements the count once", async () => {
    const sb = makeChain([
      { data: { id: FID, uidvalidity: 1000, canonical: "drafts" } }, // ensureFolderRow select
      { data: { id: "row" } }, // .update().select().maybeSingle() -> live row
      { data: true }, // rpc adjust (-1)
    ]);
    const res = await tombstoneDraftProjection(sb, delInput());
    expect(res.changed).toBe(true);
    const rpcDeltas = sb.calls
      .filter((c) => c.table === "rpc")
      .map((c) => (c.ops[0][2] as Record<string, number>).p_total_delta);
    expect(rpcDeltas).toEqual([-1]);
  });

  it("is idempotent: an already-tombstoned row returns changed=false and does NOT decrement", async () => {
    const sb = makeChain([
      { data: { id: FID, uidvalidity: 1000, canonical: "drafts" } }, // ensureFolderRow select
      { data: null }, // .update().select().maybeSingle() -> no live row
    ]);
    const res = await tombstoneDraftProjection(sb, delInput());
    expect(res.changed).toBe(false);
    expect(sb.calls.some((c) => c.table === "rpc")).toBe(false);
  });

  it("short-circuits without touching the DB for invalid uid/uidValidity", async () => {
    const sb = makeChain([]);
    expect((await tombstoneDraftProjection(sb, delInput({ uid: 0 }))).changed).toBe(false);
    expect((await tombstoneDraftProjection(sb, delInput({ uidValidity: "" }))).changed).toBe(false);
    expect(sb.calls).toHaveLength(0);
  });
});
