// Contract tests for the message body cache (MAILMAESTRO_BODY_CACHE).
//
// Locked behaviours:
//   * hit only when UIDVALIDITY matches the folder AND the index row is alive
//   * a stale UIDVALIDITY can never serve a body
//   * a deleted/moved (orphan) message can never serve a body
//   * drafts are never cached
//   * an oversized body is recorded WITHOUT content, never truncated
import { describe, it, expect, vi } from "vitest";
import {
  lookupCachedBody,
  storeCachedBody,
  isCacheableFolder,
  byteLength,
  BODY_CACHE_VERSION,
} from "../mail-body-cache.server";

type Row = Record<string, unknown> | null;

/** Minimal PostgREST-shaped fake: one canned result per table. */
function fakeSupabase(results: Record<string, Row>, spy?: { upserts: unknown[] }) {
  const make = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "is", "in", "lt", "order", "limit", "delete", "update"]) {
      chain[m] = vi.fn(self);
    }
    chain["maybeSingle"] = vi.fn(async () => ({ data: results[table] ?? null, error: null }));
    chain["upsert"] = vi.fn(async (payload: unknown) => {
      spy?.upserts.push(payload);
      return { error: null };
    });
    chain["then"] = undefined;
    return chain;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => make(t) } as any;
}

const KEY = { companyId: "c1", accountId: "a1", canonical: "inbox", uid: 42 };

const CACHED = {
  uid_validity: 100,
  body_html: "<p>hello</p>",
  body_text: null,
  preview: "hello",
  inline_parts: [],
  attachments: [],
  byte_size: 12,
  oversize: false,
};

describe("lookupCachedBody", () => {
  it("hits when uidvalidity matches and the index row is alive", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: CACHED,
      mail_messages: { id: "m1" },
    });
    const res = await lookupCachedBody(db, KEY);
    expect(res.hit).toBe(true);
    if (res.hit) expect(res.body.bodyHtml).toBe("<p>hello</p>");
  });

  it("misses when the folder UIDVALIDITY changed", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 101 },
      mail_message_body_cache: CACHED,
      mail_messages: { id: "m1" },
    });
    const res = await lookupCachedBody(db, KEY);
    expect(res).toEqual({ hit: false, reason: "uidvalidity" });
  });

  it("never serves an orphan body when the index row is gone", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: CACHED,
      mail_messages: null,
    });
    const res = await lookupCachedBody(db, KEY);
    expect(res).toEqual({ hit: false, reason: "orphan" });
  });

  it("misses when nothing is cached", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: null,
    });
    const res = await lookupCachedBody(db, KEY);
    expect(res).toEqual({ hit: false, reason: "no-row" });
  });

  it("misses when the row is marked oversize", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: { ...CACHED, oversize: true, body_html: null },
      mail_messages: { id: "m1" },
    });
    const res = await lookupCachedBody(db, KEY);
    expect(res).toEqual({ hit: false, reason: "oversize" });
  });
});

describe("storeCachedBody", () => {
  it("never caches drafts", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const out = await storeCachedBody(db, {
      ...KEY,
      canonical: "drafts",
      uidValidity: "100",
      bodyHtml: "<p>x</p>",
      preview: "x",
      inlineParts: [],
      attachments: [],
    });
    expect(out).toBe("skipped");
    expect(spy.upserts).toHaveLength(0);
    expect(isCacheableFolder("drafts")).toBe(false);
    expect(isCacheableFolder("inbox")).toBe(true);
  });

  it("stores a normal body with the current cache version", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const out = await storeCachedBody(db, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: "<p>x</p>",
      preview: "x",
      inlineParts: [],
      attachments: [],
    });
    expect(out).toBe("stored");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["cache_version"]).toBe(BODY_CACHE_VERSION);
    expect(row["body_html"]).toBe("<p>x</p>");
    expect(row["oversize"]).toBe(false);
  });

  it("records an oversized body with NO content instead of truncating it", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const big = "x".repeat(200);
    const out = await storeCachedBody(
      db,
      {
        ...KEY,
        uidValidity: "100",
        bodyHtml: big,
        preview: "x",
        inlineParts: [],
        attachments: [],
      },
      { maxBytes: 100, maxAgeDays: 14, maxRowsPerAccount: 100, warmBatch: 5, warmWindow: 100 },
    );
    expect(out).toBe("oversize");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["oversize"]).toBe(true);
    expect(row["body_html"]).toBeNull();
    expect(row["byte_size"]).toBe(byteLength(big));
  });

  it("skips an invalid uidvalidity", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const out = await storeCachedBody(db, {
      ...KEY,
      uidValidity: "0",
      bodyHtml: "<p>x</p>",
      preview: "x",
      inlineParts: [],
      attachments: [],
    });
    expect(out).toBe("skipped");
    expect(spy.upserts).toHaveLength(0);
  });
});
