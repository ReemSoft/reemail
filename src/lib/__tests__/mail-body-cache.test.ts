// Contract tests for the message body cache (MAILMAESTRO_BODY_CACHE).
//
// Locked behaviours:
//   * hit only when UIDVALIDITY matches the folder AND the index row is alive
//   * a stale UIDVALIDITY can never serve a body
//   * a deleted/moved (orphan) message can never serve a body
//   * drafts are never cached
//   * an oversized body is recorded WITHOUT content, never truncated
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  cleanupBodyCache,
  lookupCachedBody,
  lookupCachedBodyWithMailboxHint,
  storeCachedBody,
  touchCachedBody,
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
  inline_images: [],
  attachments: [],
  headers_meta: {},
  byte_size: 12,
  oversize: false,
};

describe("lookupCachedBody", () => {
  it("reuses the folder query as a bounded server-only mailbox hint", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100, path: "[Gmail]/Sent Mail" },
      mail_message_body_cache: null,
    });

    const result = await lookupCachedBodyWithMailboxHint(db, { ...KEY, canonical: "sent" });

    expect(result.lookup).toEqual({ hit: false, reason: "no-row" });
    expect(result.mailboxHint).toEqual({
      folderId: "f1",
      path: "[Gmail]/Sent Mail",
      expectedUidValidity: "100",
    });
  });

  it("fails closed without a valid physical path and UIDVALIDITY", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100, path: "" },
      mail_message_body_cache: null,
    });

    const result = await lookupCachedBodyWithMailboxHint(db, KEY);

    expect(result.lookup).toEqual({ hit: false, reason: "no-row" });
    expect(result.mailboxHint).toBeUndefined();
  });

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

  it("returns cached Reply-To metadata without a Bridge or IMAP fallback", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        headers_meta: {
          replyTo: [
            { name: "الدعم", email: "support@example.com" },
            { name: "Injected\r\nBcc: bad", email: "bad\r\n@example.com" },
          ],
        },
      },
      mail_messages: { id: "m1" },
    });
    const res = await lookupCachedBody(db, KEY);
    expect(res.hit).toBe(true);
    if (res.hit) {
      expect(res.body.headersMeta?.replyTo).toEqual([
        { name: "الدعم", email: "support@example.com" },
      ]);
    }
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

  it("repairs only a legacy cache row whose referenced CID has no metadata", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        body_html: '<p>photo</p><img src="cid:mobile-photo@example">',
      },
      mail_messages: { id: "m1" },
    });
    expect(await lookupCachedBody(db, KEY)).toEqual({
      hit: false,
      reason: "incomplete-inline",
    });
  });

  it("does not repeatedly refetch a current row with an unavailable CID", async () => {
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        body_html: '<p>photo</p><img src="cid:unavailable@example">',
        headers_meta: { _inlineCidMetadataVersion: 1 },
      },
      mail_messages: { id: "m1" },
    });
    expect((await lookupCachedBody(db, KEY)).hit).toBe(true);
  });

  it("recovers a referenced 1.8 MiB CID image from legacy cached attachments", async () => {
    const largeSize = Math.round(1.8 * 1024 * 1024);
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        body_html: '<p>text</p><img src="cid:mm-inline-large@mailmaestro">',
        inline_parts: [],
        attachments: [
          {
            id: "inline-image",
            filename: "mm-inline-large.png",
            contentId: "<mm-inline-large@mailmaestro>",
            part: "2",
            mimeType: "image/png",
            size: largeSize,
            disposition: "inline",
          },
          {
            id: "document",
            filename: "document.pdf",
            part: "3",
            mimeType: "application/pdf",
            size: 1000,
            disposition: "attachment",
          },
        ],
      },
      mail_messages: { id: "m1" },
    });

    const res = await lookupCachedBody(db, KEY);

    expect(res.hit).toBe(true);
    if (!res.hit) return;
    expect(res.body.inlineParts).toEqual([
      {
        cid: "mm-inline-large@mailmaestro",
        part: "2",
        mimeType: "image/png",
        size: largeSize,
      },
    ]);
    expect(res.body.attachments).toEqual([
      expect.objectContaining({ filename: "document.pdf", mimeType: "application/pdf" }),
    ]);
  });

  it("keeps unreferenced CID images and normal attachments unchanged", async () => {
    const attachments = [
      {
        id: "image",
        filename: "photo.png",
        contentId: "unreferenced@example",
        part: "2",
        mimeType: "image/png",
        size: 200,
      },
      {
        id: "document",
        filename: "document.pdf",
        part: "3",
        mimeType: "application/pdf",
        size: 1000,
      },
    ];
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: { ...CACHED, attachments },
      mail_messages: { id: "m1" },
    });

    const res = await lookupCachedBody(db, KEY);

    expect(res.hit).toBe(true);
    if (!res.hit) return;
    expect(res.body.inlineParts).toEqual([]);
    expect(res.body.attachments).toEqual(attachments);
  });

  it("preserves an existing valid new-format inline part", async () => {
    const inlineParts = [{ cid: "current@example", part: "2", mimeType: "image/png", size: 400 }];
    const attachments = [
      {
        id: "document",
        filename: "document.pdf",
        part: "3",
        mimeType: "application/pdf",
        size: 1000,
      },
    ];
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        body_html: '<img src="cid:current@example">',
        inline_parts: inlineParts,
        attachments,
      },
      mail_messages: { id: "m1" },
    });

    const res = await lookupCachedBody(db, KEY);

    expect(res.hit).toBe(true);
    if (!res.hit) return;
    expect(res.body.inlineParts).toEqual(inlineParts);
    expect(res.body.attachments).toEqual(attachments);
  });

  it("deduplicates existing metadata and matches bracketed CIDs case-insensitively", async () => {
    const existingPart = {
      cid: "Logo@Example",
      part: "2",
      mimeType: "image/png",
      size: 300,
    };
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        body_html: '<img alt="logo" src="CID:logo@example">',
        inline_parts: [existingPart],
        attachments: [
          {
            id: "legacy-duplicate",
            filename: "logo.png",
            contentId: "<LOGO@EXAMPLE>",
            part: "2",
            mimeType: "image/png",
            size: 300,
          },
        ],
      },
      mail_messages: { id: "m1" },
    });

    const res = await lookupCachedBody(db, KEY);

    expect(res.hit).toBe(true);
    if (!res.hit) return;
    expect(res.body.inlineParts).toEqual([existingPart]);
    expect(res.body.attachments).toEqual([]);
  });

  it("does not promote malformed, disallowed, or over-5-MiB legacy metadata", async () => {
    const attachments = [
      {
        id: "bad-part",
        filename: "bad-part.png",
        contentId: "bad-part",
        part: "2.x",
        mimeType: "image/png",
        size: 100,
      },
      {
        id: "bad-mime",
        filename: "vector.svg",
        contentId: "bad-mime",
        part: "3",
        mimeType: "image/svg+xml",
        size: 100,
      },
      {
        id: "too-large",
        filename: "too-large.png",
        contentId: "too-large",
        part: "4",
        mimeType: "image/png",
        size: 5 * 1024 * 1024 + 1,
      },
    ];
    const db = fakeSupabase({
      mail_folders: { id: "f1", uidvalidity: 100 },
      mail_message_body_cache: {
        ...CACHED,
        body_html: '<img src="cid:bad-part"><img src="cid:bad-mime"><img src="cid:too-large">',
        attachments,
      },
      mail_messages: { id: "m1" },
    });

    const res = await lookupCachedBody(db, KEY);

    expect(res.hit).toBe(true);
    if (!res.hit) return;
    expect(res.body.inlineParts).toEqual([]);
    expect(res.body.attachments).toEqual(attachments);
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
    expect(row["headers_meta"]).toEqual(expect.objectContaining({ _inlineCidMetadataVersion: 1 }));
  });

  it("stores Reply-To inside the existing bounded headers JSON", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    await storeCachedBody(db, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: "<p>x</p>",
      preview: "x",
      inlineParts: [],
      attachments: [],
      headersMeta: { replyTo: [{ name: "Support", email: "support@example.com" }] },
    });
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["headers_meta"]).toEqual({
      _inlineCidMetadataVersion: 1,
      mailedBy: undefined,
      signedBy: undefined,
      security: undefined,
      replyTo: [{ name: "Support", email: "support@example.com" }],
    });
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
      {
        maxBytes: 100,
        maxAgeDays: 14,
        maxRowsPerAccount: 100,
        warmBatch: 5,
        warmWindow: 100,
        inlineMaxBytes: 1536 * 1024,
      },
    );
    expect(out).toBe("oversize");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["oversize"]).toBe(true);
    expect(row["body_html"]).toBeNull();
    expect(row["byte_size"]).toBe(byteLength(big));
  });

  it("forces a truncated body into the existing oversize marker even above the cache budget", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const partial = "x".repeat(200);
    const out = await storeCachedBody(
      db,
      {
        ...KEY,
        uidValidity: "100",
        bodyHtml: partial,
        bodyTruncated: true,
        preview: "x",
        inlineParts: [],
        attachments: [],
      },
      {
        maxBytes: 1_000,
        maxAgeDays: 14,
        maxRowsPerAccount: 100,
        warmBatch: 5,
        warmWindow: 100,
        inlineMaxBytes: 1536 * 1024,
      },
    );
    expect(out).toBe("oversize");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["cache_version"]).toBe(3);
    expect(row["oversize"]).toBe(true);
    expect(row["body_html"]).toBeNull();
    expect(row["byte_size"]).toBe(byteLength(partial));

    const lookup = await lookupCachedBody(
      fakeSupabase({
        mail_folders: { id: "f1", uidvalidity: 100 },
        mail_message_body_cache: row,
        mail_messages: { id: "m1" },
      }),
      KEY,
    );
    expect(lookup).toEqual({ hit: false, reason: "oversize" });
  });

  it("persists embedded inline images with the body", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const out = await storeCachedBody(db, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: '<p>hi <img src="cid:logo"></p>',
      preview: "hi",
      inlineParts: [],
      inlineImages: [
        {
          cid: "logo",
          part: "2",
          mimeType: "image/png",
          size: 4,
          dataUri: "data:image/png;base64,AAAA",
        },
      ],
      attachments: [],
    });
    expect(out).toBe("stored");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["inline_images"]).toHaveLength(1);
    expect(row["inline_parts"]).toEqual([]);
  });

  it("persists large CID metadata without storing its bytes", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const largePart = {
      cid: "mm-inline-large@mailmaestro",
      part: "2",
      mimeType: "image/png",
      size: Math.round(1.8 * 1024 * 1024),
    };
    const out = await storeCachedBody(db, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: `<p>text</p><img src="cid:${largePart.cid}">`,
      preview: "text",
      inlineParts: [largePart],
      inlineImages: [],
      attachments: [],
    });
    expect(out).toBe("stored");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["inline_parts"]).toEqual([largePart]);
    // An empty embedded-image set leaves `inline_images` untouched so a later
    // interactive CID resolution can persist bytes without being overwritten.
    expect("inline_images" in row).toBe(false);
  });

  it("a body refresh without embedded images preserves previously persisted bytes", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    await storeCachedBody(db, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: "<p>hi</p>",
      preview: "hi",
      inlineParts: [],
      inlineImages: [
        {
          cid: "logo",
          part: "2",
          mimeType: "image/png",
          size: 4,
          dataUri: "data:image/png;base64,AAAA",
        },
      ],
      attachments: [],
    });
    const withImages = spy.upserts[0] as Record<string, unknown>;
    expect(withImages["inline_images"]).toHaveLength(1);

    // The deferred-CID open path re-stores the body with no embedded images;
    // the upsert must NOT clobber the persisted inline_images column.
    await storeCachedBody(db, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: "<p>hi</p>",
      preview: "hi",
      inlineParts: [],
      inlineImages: [],
      attachments: [],
    });
    const refreshed = spy.upserts[1] as Record<string, unknown>;
    expect("inline_images" in refreshed).toBe(false);
  });

  it("demotes oversized inline images to lazy metadata instead of dropping them", async () => {
    const spy = { upserts: [] as unknown[] };
    const db = fakeSupabase({}, spy);
    const out = await storeCachedBody(
      db,
      {
        ...KEY,
        uidValidity: "100",
        bodyHtml: "<p>hi</p>",
        preview: "hi",
        inlineParts: [],
        inlineImages: [
          {
            cid: "big",
            part: "3",
            mimeType: "image/png",
            size: 999,
            dataUri: `data:image/png;base64,${"A".repeat(500)}`,
          },
        ],
        attachments: [],
      },
      {
        maxBytes: 512 * 1024,
        maxAgeDays: 14,
        maxRowsPerAccount: 100,
        warmBatch: 5,
        warmWindow: 100,
        inlineMaxBytes: 100,
      },
    );
    expect(out).toBe("stored");
    const row = spy.upserts[0] as Record<string, unknown>;
    expect(row["inline_images"]).toEqual([]);
    expect(row["inline_parts"]).toEqual([
      { cid: "big", part: "3", mimeType: "image/png", size: 999 },
    ]);
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

  it("fails closed when the asynchronous cache store fails", async () => {
    const chain = {
      upsert: vi.fn(async () => ({ error: new Error("store failed") })),
    };
    const db = { from: vi.fn(() => chain) };
    const out = await storeCachedBody(db as never, {
      ...KEY,
      uidValidity: "100",
      bodyHtml: "<p>x</p>",
      preview: "x",
      inlineParts: [],
      attachments: [],
    });
    expect(out).toBe("skipped");
  });
});

describe("cache lifecycle", () => {
  it("swallows an LRU touch failure without throwing into the response path", async () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["update", "eq"]) chain[method] = vi.fn(() => chain);
    chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.reject(new Error("touch failed")).then(resolve, reject);
    const db = { from: vi.fn(() => chain) };
    expect(() => touchCachedBody(db as never, KEY)).not.toThrow();
    await Promise.resolve();
  });

  it("keeps cleanup bounded and outside normal message-open/cache-hit paths", async () => {
    const responses = [
      { data: [{ id: "expired" }], error: null },
      { data: [{ id: "keep-1" }, { id: "keep-2" }, { id: "stale-1" }], error: null },
      { data: [{ id: "stale-1" }], error: null },
    ];
    const limits: number[] = [];
    const db = {
      from: vi.fn(() => {
        const chain: Record<string, unknown> = {};
        for (const method of ["delete", "eq", "lt", "select", "order", "in"]) {
          chain[method] = vi.fn(() => chain);
        }
        chain.limit = vi.fn((value: number) => {
          limits.push(value);
          return chain;
        });
        chain.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve(responses.shift()).then(resolve);
        return chain;
      }),
    };
    const evicted = await cleanupBodyCache(
      db as never,
      { companyId: "c1", accountId: "a1" },
      {
        maxBytes: 512 * 1024,
        maxAgeDays: 14,
        maxRowsPerAccount: 2,
        warmBatch: 5,
        warmWindow: 100,
        inlineMaxBytes: 1536 * 1024,
      },
    );
    expect(evicted).toBe(2);
    expect(db.from).toHaveBeenCalledTimes(3);
    expect(limits).toEqual([202]);

    const source = readFileSync(
      new URL("../mail-message-open.functions.ts", import.meta.url),
      "utf8",
    );
    const normalOpen = source.slice(
      source.indexOf("export const openMailMessage"),
      source.indexOf("const EntireMessageSchema"),
    );
    expect(normalOpen).not.toContain("cleanupBodyCache");
    expect(source.slice(source.indexOf("export const warmMessageBodies"))).toContain(
      ".cleanupBodyCache",
    );
  });
});
