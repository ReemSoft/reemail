// Targeted regression tests for the three final Draft V4 correctness fixes:
//   FIX 1 — authoritative large-Draft count (refreshFolderCounts persists the
//           sync-provided UNDELETED total, not the local page count).
//   FIX 2 — projection tombstone on remote-delete success even when the server
//           copy was already gone (deleted=false).
//   FIX 3 — Save-as-Draft never closes while the composer is still dirty.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { refreshFolderCounts } from "../mail-sync-writer.server";

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
      for (const m of ["select", "update", "insert", "upsert", "eq", "is", "maybeSingle"]) {
        chain[m] = push(m);
      }
      chain.then = (resolve: (v: unknown) => void) => resolve(terminals[cursor++] ?? {});
      return chain;
    },
  };
  return client as unknown as import("@supabase/supabase-js").SupabaseClient & typeof client;
}

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("FIX 1 — authoritative large Draft count", () => {
  it("persists the sync-provided UNDELETED total (850) instead of the local page count", async () => {
    const sb = makeChain([
      { count: 42 }, // unread count query
      {}, // mail_folders.update
    ]);
    const res = await refreshFolderCounts(sb, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "1000",
      authoritativeTotal: 850,
    });
    expect(res.total).toBe(850);
    expect(res.unread).toBe(42);
    const upCall = sb.calls.find((c) => c.table === "mail_folders" && c.ops.some(([n]) => n === "update"));
    const patch = upCall!.ops.find(([n]) => n === "update")?.[1] as Record<string, number>;
    expect(patch.total).toBe(850);
  });

  it("falls back to local COUNT when no authoritative total is provided (non-Draft)", async () => {
    const sb = makeChain([
      { count: 300 }, // total (Promise.all totalQ first)
      { count: 5 }, // unread
      {}, // mail_folders.update
    ]);
    const res = await refreshFolderCounts(sb, {
      accountId: ACC,
      folderId: FID,
      uidValidity: "1000",
      authoritativeTotal: null,
    });
    expect(res.total).toBe(300);
  });
});

describe("FIX 2 — projection tombstone on already-remote-deleted", () => {
  it("bridgeDeleteDraft tombstones the projection whenever the remote delete succeeds, not only when deleted===true", () => {
    const src = readFileSync(new URL("../mail-bridge.functions.ts", import.meta.url), "utf8");
    // The tombstone gate must NOT depend on `deleted` (it must run for ok=true,
    // deleted=false as well). It must still be scoped by folderPath + previousRef.
    const block = src.slice(src.indexOf("tombstoneDraftProjection") - 400, src.indexOf("tombstoneDraftProjection") + 40);
    expect(block).not.toMatch(/deleted\s*&&\s*folderPath/);
    expect(src).toContain("tombstoneDraftProjection(supabaseAdmin");
  });
});

describe("FIX 3 — Save-as-Draft never closes dirty", () => {
  it("handleSaveAsDraft closes only when the latest save succeeded AND the composer is clean", () => {
    const src = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
    const idx = src.indexOf("async function handleSaveAsDraft");
    const fn = src.slice(idx, idx + 600);
    expect(fn).toContain('if (result === "saved_server" && !isDirtyRef.current) closeComposer();');
  });
});
