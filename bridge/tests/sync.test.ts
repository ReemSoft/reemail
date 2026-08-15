import { test } from "node:test";
import assert from "node:assert/strict";
import type { FetchMessageObject, MessageStructureObject } from "imapflow";
import {
  detectHasAttachments,
  normalizeAddress,
  normalizeMessage,
  extractKeywords,
  bigIntToDecimalString,
  toIsoDate,
  SYSTEM_FLAGS,
  InitialSyncSchema,
  IncrementalSyncSchema,
  ReconcileSyncSchema,
  syncInitial,
  syncIncremental,
  syncReconcile,
  type SyncClient,
} from "../src/sync.js";

// ---------- helpers ----------
function structure(node: Partial<MessageStructureObject>): MessageStructureObject {
  return { type: "text/plain", ...node } as MessageStructureObject;
}

function fakeFetchMessage(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: 1,
    uid: 1,
    flags: new Set(["\\Seen"]),
    envelope: {
      date: new Date("2025-01-01T00:00:00Z"),
      subject: "Hello",
      messageId: "<a@b>",
      from: [{ name: "A", address: "A@Example.com" }],
      to: [{ name: "B", address: "b@example.com" }],
    },
    internalDate: new Date("2025-01-01T00:00:00Z"),
    size: 1234,
    bodyStructure: structure({ type: "text/plain" }),
    ...overrides,
  } as FetchMessageObject;
}

class FakeLock {
  released = false;
  release() { this.released = true; }
  path = "INBOX";
}

interface FakeClientOpts {
  mailbox?: SyncClient["mailbox"];
  capabilities?: Iterable<string>;
  messages?: FetchMessageObject[];
  onFetch?: (range: string | number[], query: any, opts?: any) => void;
  throwOnLock?: Error;
}

function makeFakeClient(opts: FakeClientOpts): SyncClient & { lock: FakeLock; fetchCalls: any[] } {
  const lock = new FakeLock();
  const caps = new Map<string, boolean | number>();
  for (const c of opts.capabilities ?? []) caps.set(c, true);
  const fetchCalls: any[] = [];
  return {
    lock,
    fetchCalls,
    capabilities: caps,
    mailbox: opts.mailbox ?? false,
    async getMailboxLock() {
      if (opts.throwOnLock) throw opts.throwOnLock;
      return lock;
    },
    async *fetch(range, query, options) {
      fetchCalls.push({ range, query, options });
      opts.onFetch?.(range, query, options);
      for (const m of opts.messages ?? []) yield m;
    },
  };
}

// ---------- pure helpers ----------

test("detectHasAttachments: text-only returns false", () => {
  assert.equal(detectHasAttachments(structure({ type: "text/plain" })), false);
});

test("detectHasAttachments: multipart/alternative text+html returns false", () => {
  const s = structure({
    type: "multipart/alternative",
    childNodes: [
      structure({ type: "text/plain" }),
      structure({ type: "text/html" }),
    ],
  });
  assert.equal(detectHasAttachments(s), false);
});

test("detectHasAttachments: PDF disposition=attachment returns true", () => {
  const s = structure({
    type: "multipart/mixed",
    childNodes: [
      structure({ type: "text/plain" }),
      structure({ type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "a.pdf" } }),
    ],
  });
  assert.equal(detectHasAttachments(s), true);
});

test("detectHasAttachments: ZIP nested returns true", () => {
  const s = structure({
    type: "multipart/mixed",
    childNodes: [
      structure({
        type: "multipart/alternative",
        childNodes: [structure({ type: "text/plain" }), structure({ type: "text/html" })],
      }),
      structure({ type: "application/zip", disposition: "attachment", dispositionParameters: { filename: "x.zip" } }),
    ],
  });
  assert.equal(detectHasAttachments(s), true);
});

test("detectHasAttachments: inline image with filename returns true", () => {
  const s = structure({
    type: "multipart/related",
    childNodes: [
      structure({ type: "text/html" }),
      structure({ type: "image/png", disposition: "inline", dispositionParameters: { filename: "logo.png" } }),
    ],
  });
  assert.equal(detectHasAttachments(s), true);
});

test("detectHasAttachments: inline image without filename returns false", () => {
  const s = structure({
    type: "multipart/related",
    childNodes: [
      structure({ type: "text/html" }),
      structure({ type: "image/png", disposition: "inline" }),
    ],
  });
  assert.equal(detectHasAttachments(s), false);
});

test("detectHasAttachments: null/undefined structure returns false", () => {
  assert.equal(detectHasAttachments(null), false);
  assert.equal(detectHasAttachments(undefined), false);
});

test("normalizeAddress: lowers email and trims name; null when invalid", () => {
  assert.deepEqual(normalizeAddress({ name: " A ", address: "  A@X.COM " }), { name: "A", email: "a@x.com" });
  assert.equal(normalizeAddress({ name: "", address: "" }), null);
  assert.equal(normalizeAddress({ name: "X", address: "not-an-email" }), null);
  assert.equal(normalizeAddress(null), null);
  assert.equal(normalizeAddress({ address: "a@b" } as any).name, null);
});

test("extractKeywords: strips system flags", () => {
  const kws = extractKeywords(["\\Seen", "\\Flagged", "$Label1", "custom"]);
  assert.deepEqual(kws.sort(), ["$Label1", "custom"].sort());
  for (const f of SYSTEM_FLAGS) assert.ok(!kws.includes(f));
});

test("bigIntToDecimalString: bigint → string, null → null", () => {
  assert.equal(bigIntToDecimalString(12345678901234567890n), "12345678901234567890");
  assert.equal(bigIntToDecimalString(undefined), null);
  assert.equal(bigIntToDecimalString(null), null);
});

test("toIsoDate: Date, string, invalid → epoch", () => {
  assert.equal(toIsoDate(new Date("2025-05-01T00:00:00Z")), "2025-05-01T00:00:00.000Z");
  assert.equal(toIsoDate("2025-05-01T00:00:00Z"), "2025-05-01T00:00:00.000Z");
  assert.equal(toIsoDate("not-a-date"), new Date(0).toISOString());
});

test("normalizeMessage: shape has no body/source/headers and modseq is decimal string", () => {
  const m = fakeFetchMessage({ modseq: 42n, flags: new Set(["\\Seen", "\\Flagged", "kw1"]) });
  const out = normalizeMessage(m);
  assert.equal(out.uid, 1);
  assert.equal(out.modseq, "42");
  assert.equal(out.subject, "Hello");
  assert.deepEqual(out.from, { name: "A", email: "a@example.com" });
  assert.equal(out.flagSeen, true);
  assert.equal(out.flagFlagged, true);
  assert.deepEqual(out.keywords, ["kw1"]);
  assert.equal(out.hasAttachments, false);
  assert.equal(out.flagDeleted, false, "\\Deleted must be surfaced for Draft sync filtering");
  // No body / html / preview / source / headers keys
  for (const k of ["body", "html", "text", "preview", "source", "headers", "raw"]) {
    assert.ok(!(k in out), `unexpected key ${k}`);
  }
});

test("normalizeMessage: surfaces \\Deleted flag for soft-deleted copies", () => {
  const m = fakeFetchMessage({ flags: new Set(["\\Deleted", "\\Draft"]) });
  const out = normalizeMessage(m);
  assert.equal(out.flagDeleted, true);
  assert.equal(out.flagDraft, true);
});

// ---------- Zod validation ----------

const validAccount = {
  email_address: "u@example.com",
  display_name: "U",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_secure: true,
};

test("InitialSyncSchema: rejects empty folderPath", () => {
  const r = InitialSyncSchema.safeParse({ account: validAccount, password: "x", folderPath: "" });
  assert.equal(r.success, false);
});

test("InitialSyncSchema: rejects limit > max", () => {
  const r = InitialSyncSchema.safeParse({ account: validAccount, password: "x", folderPath: "INBOX", limit: 5000 });
  assert.equal(r.success, false);
});

test("InitialSyncSchema: rejects unknown top-level fields", () => {
  const r = InitialSyncSchema.safeParse({
    account: validAccount, password: "x", folderPath: "INBOX", nefarious: true,
  });
  assert.equal(r.success, false);
});

test("sync schemas accept countExcludeDeleted (Draft authoritative live count)", () => {
  assert.equal(
    InitialSyncSchema.safeParse({
      account: validAccount, password: "x", folderPath: "Drafts", countExcludeDeleted: true,
    }).success,
    true,
  );
  assert.equal(
    IncrementalSyncSchema.safeParse({
      account: validAccount, password: "x", folderPath: "Drafts",
      sinceUid: 10, countExcludeDeleted: true,
    }).success,
    true,
  );
  assert.equal(
    ReconcileSyncSchema.safeParse({
      account: validAccount, password: "x", folderPath: "Drafts",
      expectedUidValidity: "1", fromUid: 1, toUid: 5, countExcludeDeleted: true,
    }).success,
    true,
  );
});

test("IncrementalSyncSchema: rejects non-decimal modseq", () => {
  const r = IncrementalSyncSchema.safeParse({
    account: validAccount, password: "x", folderPath: "INBOX",
    sinceUid: 10, sinceModseq: "abc", flagsFromUid: 1, flagsToUid: 5,
  });
  assert.equal(r.success, false);
});

test("IncrementalSyncSchema: rejects oversized flag range", () => {
  const r = IncrementalSyncSchema.safeParse({
    account: validAccount, password: "x", folderPath: "INBOX",
    sinceUid: 10, sinceModseq: "5", flagsFromUid: 1, flagsToUid: 5000,
  });
  assert.equal(r.success, false);
});

test("ReconcileSyncSchema: rejects toUid < fromUid", () => {
  const r = ReconcileSyncSchema.safeParse({
    account: validAccount, password: "x", folderPath: "INBOX",
    expectedUidValidity: "10", fromUid: 100, toUid: 50,
  });
  assert.equal(r.success, false);
});

test("ReconcileSyncSchema: rejects oversized range", () => {
  const r = ReconcileSyncSchema.safeParse({
    account: validAccount, password: "x", folderPath: "INBOX",
    expectedUidValidity: "10", fromUid: 1, toUid: 5000,
  });
  assert.equal(r.success, false);
});

test("Schemas reject NaN / Infinity", () => {
  const r = InitialSyncSchema.safeParse({
    account: validAccount, password: "x", folderPath: "INBOX", limit: Number.POSITIVE_INFINITY,
  });
  assert.equal(r.success, false);
});

// ---------- syncInitial (fake client) ----------

test("syncInitial: empty mailbox returns no messages, releases lock", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 0, uidValidity: 10n, uidNext: 1 },
    messages: [],
  });
  const r = await syncInitial(client, { folderPath: "INBOX", limit: 300 });
  assert.equal(r.messages.length, 0);
  assert.equal(r.newestReturnedUid, null);
  assert.equal(client.lock.released, true);
});

test("syncInitial requests only References header and never source/body/bodyParts", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 5, uidValidity: 10n, uidNext: 6 },
    messages: [1, 2, 3, 4, 5].map((uid) => fakeFetchMessage({ uid })),
  });
  await syncInitial(client, { folderPath: "INBOX", limit: 300 });
  assert.equal(client.fetchCalls.length, 1);
  const q = client.fetchCalls[0].query;
  assert.equal(q.source, undefined);
  assert.equal(q.body, undefined);
  assert.equal(q.bodyParts, undefined);
  // The ONLY extra header allowed in the sync path (RFC threading).
  assert.deepEqual(q.headers, ["references"]);
});

test("syncInitial: mailbox > limit uses last-N sequence range only", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 1000, uidValidity: 10n, uidNext: 1001 },
    messages: [],
  });
  await syncInitial(client, { folderPath: "INBOX", limit: 100 });
  assert.equal(client.fetchCalls[0].range, "901:1000");
});

test("syncInitial: newest-first ordering (UID desc), releases lock on fetch error", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 3, uidValidity: 10n, uidNext: 4 },
    messages: [1, 3, 2].map((uid) => fakeFetchMessage({ uid })),
  });
  const r = await syncInitial(client, { folderPath: "INBOX", limit: 300 });
  if (r.ok !== true || r.mode !== "initial") throw new Error("unexpected");
  assert.deepEqual(r.messages.map((m) => m.uid), [3, 2, 1]);
});

test("syncInitial: releases lock when fetch throws", async () => {
  const client: any = makeFakeClient({
    mailbox: { path: "INBOX", exists: 1, uidValidity: 10n, uidNext: 2 },
  });
  client.fetch = async function* () { throw new Error("boom"); };
  await assert.rejects(syncInitial(client, { folderPath: "INBOX", limit: 300 }));
  assert.equal(client.lock.released, true);
});

// ---------- syncIncremental ----------

test("syncIncremental: no new messages → empty result, no fetch call", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 10, uidValidity: 10n, uidNext: 11 },
    messages: [],
  });
  const r = await syncIncremental(client, { folderPath: "INBOX", sinceUid: 10, limit: 300 });
  if (r.resetRequired) throw new Error("unexpected");
  assert.equal(r.newMessages.length, 0);
  assert.equal(r.hasMore, false);
  assert.equal(r.nextSinceUid, 10);
  assert.equal(client.fetchCalls.length, 0);
});

test("syncIncremental: bounded window + hasMore correct", async () => {
  const msgs = [11, 12, 13].map((uid) => fakeFetchMessage({ uid }));
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 200, uidValidity: 10n, uidNext: 201 },
    messages: msgs,
  });
  const r = await syncIncremental(client, { folderPath: "INBOX", sinceUid: 10, limit: 100 });
  if (r.resetRequired) throw new Error("unexpected");
  assert.equal(client.fetchCalls[0].range, "11:110");
  assert.equal(r.nextSinceUid, 110);
  assert.equal(r.hasMore, true);
});

test("syncIncremental requests only References header and never source/body/bodyParts", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 200, uidValidity: 10n, uidNext: 201 },
    messages: [11, 12].map((uid) => fakeFetchMessage({ uid })),
  });
  const r = await syncIncremental(client, { folderPath: "INBOX", sinceUid: 10, limit: 100 });
  if (r.resetRequired) throw new Error("unexpected");
  const q = client.fetchCalls[0].query;
  assert.equal(q.source, undefined);
  assert.equal(q.body, undefined);
  assert.equal(q.bodyParts, undefined);
  assert.deepEqual(q.headers, ["references"]);
});



test("syncIncremental: UID gaps → nextSinceUid is END of window not last returned UID", async () => {
  // Server returned only UIDs 12, 15 within window 11:110 (rest expunged).
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 200, uidValidity: 10n, uidNext: 201 },
    messages: [12, 15].map((uid) => fakeFetchMessage({ uid })),
  });
  const r = await syncIncremental(client, { folderPath: "INBOX", sinceUid: 10, limit: 100 });
  if (r.resetRequired) throw new Error("unexpected");
  assert.equal(r.nextSinceUid, 110);
});

test("syncIncremental: UIDVALIDITY mismatch → resetRequired, no fetch", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 200, uidValidity: 99n, uidNext: 201 },
  });
  const r = await syncIncremental(client, {
    folderPath: "INBOX", expectedUidValidity: "10", sinceUid: 5, limit: 100,
  });
  assert.equal(r.resetRequired, true);
  if (r.resetRequired) assert.equal(r.reason, "UIDVALIDITY_CHANGED");
  assert.equal(client.fetchCalls.length, 0);
});

test("syncIncremental: CONDSTORE supported → changedSince passed as BigInt", async () => {
  let observedOpts: any = null;
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 20, uidValidity: 10n, uidNext: 21, highestModseq: 500n },
    capabilities: ["CONDSTORE"],
    messages: [],
    onFetch: (_r, _q, o) => { if (o?.changedSince) observedOpts = o; },
  });
  const r = await syncIncremental(client, {
    folderPath: "INBOX", sinceUid: 20, sinceModseq: "100", flagsFromUid: 1, flagsToUid: 20, limit: 300,
  });
  if (r.resetRequired) throw new Error("unexpected");
  assert.equal(r.flagsSync, "condstore");
  assert.ok(observedOpts && typeof observedOpts.changedSince === "bigint");
  assert.equal(observedOpts.changedSince, 100n);
});

test("syncIncremental: CONDSTORE unsupported (noModseq) → reconcile-required", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 20, uidValidity: 10n, uidNext: 21, noModseq: true },
  });
  const r = await syncIncremental(client, {
    folderPath: "INBOX", sinceUid: 20, sinceModseq: "100", flagsFromUid: 1, flagsToUid: 20, limit: 300,
  });
  if (r.resetRequired) throw new Error("unexpected");
  assert.equal(r.flagsSync, "reconcile-required");
});

// ---------- syncReconcile ----------

test("syncReconcile: returns flags only for range, sorted asc", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 100, uidValidity: 10n, uidNext: 101 },
    messages: [5, 3, 4].map((uid) => fakeFetchMessage({ uid, flags: new Set(["\\Seen"]) })),
  });
  const r = await syncReconcile(client, { folderPath: "INBOX", expectedUidValidity: "10", fromUid: 1, toUid: 100 });
  if (r.resetRequired) throw new Error("unexpected");
  assert.deepEqual(r.states.map((s) => s.uid), [3, 4, 5]);
  // Assert the query did NOT request envelope / bodyStructure / source
  const q = client.fetchCalls[0].query;
  assert.equal(q.envelope, undefined);
  assert.equal(q.bodyStructure, undefined);
  assert.equal(q.source, undefined);
});

test("syncReconcile: UIDVALIDITY mismatch prevents fetch", async () => {
  const client = makeFakeClient({
    mailbox: { path: "INBOX", exists: 100, uidValidity: 999n, uidNext: 101 },
  });
  const r = await syncReconcile(client, { folderPath: "INBOX", expectedUidValidity: "10", fromUid: 1, toUid: 100 });
  assert.equal(r.resetRequired, true);
  assert.equal(client.fetchCalls.length, 0);
});
