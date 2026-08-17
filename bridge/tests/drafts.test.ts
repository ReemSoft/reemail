/**
 * MAILMAESTRO_DRAFT_APPEND_R1 — Bridge Drafts contract regression suite.
 *
 * These tests lock every guarantee promised by bridge/src/drafts.ts. They
 * use dependency-injected IMAP fakes exclusively — no network, no real
 * imapflow, no MailComposer stubbing (the MIME spool runs for real so we can
 * assert the X-MailMaestro-Draft-ID header actually reaches the wire).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createMimeSpool } from "../src/mime-spool.js";
import { resolveDraftsPath, resolveTrashPath } from "../src/smtp.js";
import {
  executeDraftSave,
  executeDraftDelete,
  executeDraftRevisionReconcile,
  saveDraft,
  hasImapCapability,
  DRAFT_ID_HEADER,
  DRAFT_REVISION_HEADER,
  DraftSavePayloadSchema,
  draftMutexInflight,
  type ImapDraftClient,
  type DraftSavePayload,
  type DraftDeletePayload,
  type DraftDeps,
} from "../src/drafts.js";
import type { MailAccount } from "../src/types.js";

// ---------- resolveDraftsPath ------------------------------------------------

function box(path: string, specialUse?: string): { path: string; specialUse?: string } {
  return specialUse ? { path, specialUse } : { path };
}

test("resolveDraftsPath prefers SPECIAL-USE \\Drafts over any well-known name", () => {
  const boxes = [box("INBOX"), box("Custom/WIP", "\\Drafts"), box("Drafts"), box("[Gmail]/Drafts")];
  assert.equal(resolveDraftsPath(boxes as unknown as never), "Custom/WIP");
});

test("resolveDraftsPath falls back to well-known 'Drafts' when SPECIAL-USE absent", () => {
  const boxes = [box("INBOX"), box("Sent"), box("Drafts"), box("Trash")];
  assert.equal(resolveDraftsPath(boxes as unknown as never), "Drafts");
});

test("resolveDraftsPath recognizes [Gmail]/Drafts", () => {
  const boxes = [box("INBOX"), box("[Gmail]/Drafts")];
  assert.equal(resolveDraftsPath(boxes as unknown as never), "[Gmail]/Drafts");
});

test("resolveDraftsPath returns undefined when no Drafts-like folder exists", () => {
  const boxes = [box("INBOX"), box("Trash")];
  assert.equal(resolveDraftsPath(boxes as unknown as never), undefined);
});

// ---------- Test scaffolding -------------------------------------------------

const ACCT: MailAccount = {
  email_address: "user@example.com",
  display_name: "User",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_secure: true,
};

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const REVISION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const BASE_INPUT: DraftSavePayload = DraftSavePayloadSchema.parse({
  account: ACCT,
  password: "pw",
  draftId: DRAFT_ID,
  revisionId: REVISION_ID,
  to: [{ name: "You", email: "dest@example.com" }],
  subject: "Draft subject",
  bodyText: "draft body",
});

interface FakeOpts {
  mailboxes: Array<{ path: string; specialUse?: string }>;
  uidValidity?: string;
  hasUidPlus?: boolean;
  hasMove?: boolean;
  appendUid?: number;
  appendFail?: boolean;
  searchResults?: number[][]; // per-call
  revisionSearchResults?: number[][]; // per-call
  searchFail?: boolean;
  deleteFail?: boolean;
  moveFail?: boolean;
  connectFail?: boolean;
  listFail?: boolean;
}

interface Recorder {
  connects: number;
  lists: number;
  opens: string[];
  releases: number;
  appends: Array<{ path: string; raw: Buffer; flags: string[] }>;
  searches: Array<{ name: string; value: string }>;
  deletes: Array<number[]>;
  softDeletes: Array<number[]>;
  moves: Array<{ uids: number[]; dest: string }>;
  logouts: number;
  hasUidPlusCalls: number;
  hasMoveCalls: number;
}

async function readStream(raw: NodeJS.ReadableStream | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw;
  const chunks: Buffer[] = [];
  for await (const chunk of raw as NodeJS.ReadableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function mkClient(opts: FakeOpts): { client: ImapDraftClient; rec: Recorder } {
  const rec: Recorder = {
    connects: 0,
    lists: 0,
    opens: [],
    releases: 0,
    appends: [],
    searches: [],
    deletes: [],
    softDeletes: [],
    moves: [],
    logouts: 0,
    hasUidPlusCalls: 0,
    hasMoveCalls: 0,
  };
  let searchIdx = 0;
  let revisionSearchIdx = 0;
  const client: ImapDraftClient = {
    async connect() {
      rec.connects++;
      if (opts.connectFail) throw new Error("connect failed");
    },
    async list() {
      rec.lists++;
      if (opts.listFail) throw new Error("list failed");
      return opts.mailboxes as unknown as never;
    },
    hasUidPlus() {
      rec.hasUidPlusCalls++;
      return opts.hasUidPlus ?? true;
    },
    hasMove() {
      rec.hasMoveCalls++;
      return opts.hasMove ?? false;
    },
    async openWithLock(path) {
      rec.opens.push(path);
      return {
        uidValidity: opts.uidValidity ?? "1000",
        release: () => {
          rec.releases++;
        },
      };
    },
    async searchByHeader(name, value) {
      rec.searches.push({ name, value });
      if (opts.searchFail) throw new Error("search failed");
      if (name === DRAFT_REVISION_HEADER) {
        const result = opts.revisionSearchResults?.[revisionSearchIdx] ?? [];
        revisionSearchIdx++;
        return result;
      }
      const result = opts.searchResults?.[searchIdx] ?? [];
      searchIdx++;
      return result;
    },
    async append(path, raw, flags) {
      rec.appends.push({ path, raw: await readStream(raw), flags });
      if (opts.appendFail) throw new Error("append failed");
      return {
        uid: opts.appendUid ?? 100,
        uidValidity: opts.uidValidity ?? "1000",
      };
    },
    async deleteByUid(uids) {
      rec.deletes.push([...uids]);
      if (opts.deleteFail) throw new Error("delete failed");
      return true;
    },
    async softDeleteByUid(uids) {
      rec.softDeletes.push([...uids]);
      return true;
    },
    async moveByUid(uids, dest) {
      rec.moves.push({ uids: [...uids], dest });
      if (opts.moveFail) throw new Error("move failed");
      return true;
    },
    async logout() {
      rec.logouts++;
    },
  };
  return { client, rec };
}

// ---------- Save flow tests --------------------------------------------------

test("save: APPEND uses \\Draft + \\Seen flags and resolves Drafts path", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("INBOX"), box("Drafts")],
    searchResults: [[100]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.appends[0].path, "Drafts");
  assert.deepEqual(rec.appends[0].flags, ["\\Draft", "\\Seen"]);
  assert.equal(r.folderPath, "Drafts");
});

test("save: SPECIAL-USE \\Drafts wins over well-known 'Drafts' in full save flow", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Custom/WIP", "\\Drafts")],
    searchResults: [[100]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  assert.equal(rec.appends[0].path, "Custom/WIP");
});

test("save: MIME contains X-MailMaestro-Draft-ID header with the given draftId", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[100]],
  });
  await executeDraftSave(client, BASE_INPUT);
  const mime = rec.appends[0].raw.toString("utf8");
  assert.ok(
    mime.toLowerCase().includes(DRAFT_ID_HEADER.toLowerCase()),
    `MIME missing ${DRAFT_ID_HEADER}: ${mime.slice(0, 400)}`,
  );
  assert.ok(mime.includes(DRAFT_ID), `MIME missing draftId ${DRAFT_ID}`);
});

test("save: MIME contains the PII-free logical Draft revision header", async () => {
  const { client, rec } = mkClient({ mailboxes: [box("Drafts")], searchResults: [[]] });
  await executeDraftSave(client, BASE_INPUT);
  const mime = rec.appends[0].raw.toString("utf8");
  assert.match(mime, new RegExp(DRAFT_REVISION_HEADER, "i"));
  assert.ok(mime.includes(REVISION_ID));
});

test("save: identical logical revision retry reconciles with zero APPEND", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[42]],
    revisionSearchResults: [[42]],
  });
  const result = await executeDraftSave(client, BASE_INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reconciled, true);
  assert.equal(result.uid, 42);
  assert.equal(rec.appends.length, 0);
});

test("save: newer logical revision performs exactly one APPEND", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[42]],
    revisionSearchResults: [[]],
    appendUid: 43,
  });
  const result = await executeDraftSave(client, {
    ...BASE_INPUT,
    revisionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  });
  assert.equal(result.ok, true);
  assert.equal(rec.appends.length, 1);
});

test("save: identity pre-search failure is retryable and performs zero APPEND", async () => {
  const { client, rec } = mkClient({ mailboxes: [box("Drafts")], searchFail: true });
  const result = await executeDraftSave(client, BASE_INPUT);
  assert.deepEqual(result, { ok: false, error: "RETRYABLE_DRAFT_IDENTITY_SEARCH" });
  assert.equal(rec.appends.length, 0);
});

test("revision reconciliation recovers canonical response-loss identity before source work", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "900",
    searchResults: [[71]],
    revisionSearchResults: [[71]],
  });
  const result = await executeDraftRevisionReconcile(client, BASE_INPUT);
  assert.equal(result.ok, true);
  if (!result.ok || !result.found) return;
  assert.equal(result.uid, 71);
  assert.equal(result.uidValidity, "900");
  assert.equal(result.reconciled, true);
  assert.equal(rec.appends.length, 0);
});

test("revision reconciliation exposes canonical Y when newer Z must rebind stale X sources", async () => {
  const { client } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "901",
    searchResults: [[71]],
    revisionSearchResults: [[]],
  });
  const result = await executeDraftRevisionReconcile(client, {
    ...BASE_INPUT,
    revisionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  });
  assert.deepEqual(result, {
    ok: true,
    found: false,
    canonicalRef: { folderPath: "Drafts", uid: 71, uidValidity: "901" },
  });
});

test("save: APPEND failure returns APPEND_FAILED and NEVER deletes old copies", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    appendFail: true,
    // Pre-APPEND probe returns [] so we DO reach APPEND (which then fails).
    // No second search should happen after that failure.
    searchResults: [[]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "APPEND_FAILED");
  assert.equal(rec.deletes.length, 0);
  assert.equal(rec.searches.length, 1, "only the pre-APPEND probe runs; no post search on failure");
  assert.equal(rec.logouts, 1);
});

test("draft APPEND receives a Buffer (never a stream) and cleans the spool on failure", async () => {
  const { client } = mkClient({ mailboxes: [box("Drafts")], searchResults: [[]] });
  let received: unknown = null;
  let spoolPath = "";
  client.append = async (_path, input) => {
    received = input;
    throw new Error("immediate append failure");
  };
  const result = await executeDraftSave(
    client,
    BASE_INPUT,
    () => new Date(),
    async (...args) => {
      const spool = await createMimeSpool(...args);
      spoolPath = spool.path;
      return spool;
    },
  );
  assert.deepEqual(result, { ok: false, error: "APPEND_FAILED" });
  assert.equal(Buffer.isBuffer(received), true, "APPEND must receive a Buffer, never a stream");
  await assert.rejects(access(spoolPath), /ENOENT/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("save: ordering — APPEND happens BEFORE any delete of the old copy", async () => {
  const events: string[] = [];
  const { client } = mkClient({
    mailboxes: [box("Drafts")],
    // 1st probe: [42] triggers replace mode; 2nd search: [42, 100] with 100
    // being the freshly appended UID.
    searchResults: [[42], [42, 100]],
  });
  const origAppend = client.append.bind(client);
  const origDelete = client.deleteByUid.bind(client);
  client.append = async (p, r, f) => {
    events.push("append");
    return origAppend(p, r, f);
  };
  client.deleteByUid = async (u) => {
    events.push(`delete:${u.join(",")}`);
    return origDelete(u);
  };
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  assert.deepEqual(events, ["append", "delete:42"]);
});

test("save: idempotent retry with same draftId does not create duplicates", async () => {
  // First call: no prior copies (probe:[]), post-APPEND search sees only the
  // new UID 100.
  const { client: c1, rec: r1 } = mkClient({
    mailboxes: [box("Drafts")],
    appendUid: 100,
    searchResults: [[], [100]],
  });
  await executeDraftSave(c1, BASE_INPUT);
  assert.equal(r1.appends.length, 1);
  assert.equal(r1.deletes.length, 0);

  // Second call (retry): prior copy = 100 (probe). Fresh APPEND lands at 101.
  // Post-search returns both. deleteByUid MUST be called with [100] only.
  const { client: c2, rec: r2 } = mkClient({
    mailboxes: [box("Drafts")],
    appendUid: 101,
    searchResults: [[100], [100, 101]],
  });
  const r = await executeDraftSave(c2, BASE_INPUT);
  assert.equal(r.ok, true);
  assert.equal(r2.appends.length, 1);
  assert.equal(r2.deletes.length, 1);
  assert.deepEqual(r2.deletes[0], [100]);
});

test("save: without UIDPLUS, first save (no prior copy) still succeeds", async () => {
  // Fresh draftId: pre-APPEND search returns []. Server lacks UIDPLUS, but
  // there's nothing to replace so APPEND MUST proceed.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    appendUid: 100,
    searchResults: [[], [100]], // 1st probe: none; 2nd (post-append): [100]
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  assert.equal(rec.appends.length, 1, "must APPEND on first save without UIDPLUS");
  assert.equal(rec.deletes.length, 0);
});

test("save: replace mode without UIDPLUS soft-deletes the stale copy (never global EXPUNGE)", async () => {
  // Prior copy exists AND server lacks UIDPLUS + MOVE → APPEND proceeds and
  // the stale copy is soft-deleted via UID STORE +\Deleted, never expunged.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    hasMove: false,
    appendUid: 100,
    searchResults: [[42], [42, 100]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(rec.appends.length, 1, "MUST APPEND on the soft-delete fallback");
  assert.equal(rec.deletes.length, 0, "MUST NOT UID EXPUNGE without UIDPLUS");
  assert.deepEqual(rec.softDeletes[0], [42], "MUST soft-delete exactly the stale UID");
});

test("save: explicit previousRef without UIDPLUS APPENDs then soft-deletes the legacy UID", async () => {
  // Caller signals a prior copy via previousRef even though the server search
  // returned []. The legacy UID is soft-deleted after a successful APPEND.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    hasMove: false,
    appendUid: 100,
    searchResults: [[], [100]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.deletes.length, 0);
  assert.deepEqual(rec.softDeletes[0], [42]);
});

test("save: search failure after APPEND does NOT roll back the save", async () => {
  // Pre-APPEND probe returns []; the post-APPEND search then throws. APPEND
  // has already landed and MUST be retained.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[]], // pre-APPEND probe; post-APPEND search will throw
    searchFail: false,
  });
  // Wire the second search to fail while the first succeeds.
  let calls = 0;
  client.searchByHeader = async (name, value) => {
    calls++;
    rec.searches.push({ name, value });
    if (calls === 1) return [];
    throw new Error("search failed");
  };
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true, "APPEND already succeeded; search error is non-fatal");
  assert.equal(rec.deletes.length, 0);
});

// ---------- Attachments -----------------------------------------------------

function attachmentInput(
  attachments: Array<{ filename: string; content: Buffer; contentType?: string }>,
): DraftSavePayload {
  return { ...BASE_INPUT, attachments };
}

test("attachments: none — MIME still valid and no attachment part appears", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[], [100]],
  });
  await executeDraftSave(client, BASE_INPUT);
  const mime = rec.appends[0].raw.toString("utf8");
  // No filename= directive at all when there are zero attachments.
  assert.equal(/filename=/.test(mime), false);
});

test("attachments: single file is embedded inside the MIME payload", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[], [100]],
  });
  await executeDraftSave(
    client,
    attachmentInput([
      {
        filename: "invoice.pdf",
        content: Buffer.from("PDF-BYTES-XYZ"),
        contentType: "application/pdf",
      },
    ]),
  );
  const mime = rec.appends[0].raw.toString("utf8");
  assert.ok(mime.includes("invoice.pdf"), "filename must appear in MIME headers");
  assert.ok(
    mime.toLowerCase().includes("application/pdf"),
    "content-type must appear in MIME part",
  );
  // Body must contain the base64 of the raw bytes — proves it's an actual
  // attachment part, not just metadata.
  const b64 = Buffer.from("PDF-BYTES-XYZ").toString("base64");
  assert.ok(mime.includes(b64), "attachment bytes must be base64-encoded into MIME");
});

test("attachments: multiple files each get their own MIME part", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[], [100]],
  });
  await executeDraftSave(
    client,
    attachmentInput([
      { filename: "a.txt", content: Buffer.from("AAA"), contentType: "text/plain" },
      { filename: "b.txt", content: Buffer.from("BBB"), contentType: "text/plain" },
      { filename: "c.txt", content: Buffer.from("CCC"), contentType: "text/plain" },
    ]),
  );
  const mime = rec.appends[0].raw.toString("utf8");
  assert.ok(mime.includes("a.txt"));
  assert.ok(mime.includes("b.txt"));
  assert.ok(mime.includes("c.txt"));
  assert.ok(mime.includes(Buffer.from("AAA").toString("base64")));
  assert.ok(mime.includes(Buffer.from("BBB").toString("base64")));
  assert.ok(mime.includes(Buffer.from("CCC").toString("base64")));
});

test("attachments: schema rejects unknown fields — attachments never enter via JSON payload", () => {
  // The JSON payload contract MUST NOT accept attachments (they arrive via
  // multer as disk files). If a caller tries to smuggle base64 through the
  // payload field, Zod strips it silently — this guarantees the parsed
  // payload never carries attachment bytes.
  const parsed = DraftSavePayloadSchema.parse({
    account: ACCT,
    password: "pw",
    draftId: DRAFT_ID,
    revisionId: REVISION_ID,
    subject: "s",
    bodyText: "b",
    // @ts-expect-error — smuggled attachments field
    attachments: [{ filename: "x.txt", content: "AAAA" }],
  });
  assert.equal("attachments" in parsed, false, "attachments must not be JSON-carriable");
});

// ---------- Delete flow tests -----------------------------------------------

const DELETE_INPUT: DraftDeletePayload = {
  account: ACCT,
  password: "pw",
  draftId: DRAFT_ID,
};

test("delete: idempotent — no matches returns ok:true, deleted:false", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[]],
  });
  const r = await executeDraftDelete(client, DELETE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, false);
  assert.equal(rec.deletes.length, 0);
});

test("delete: no Drafts folder is idempotent success (not an error)", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("INBOX"), box("Trash")],
  });
  const r = await executeDraftDelete(client, DELETE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.folderPath, null);
  assert.equal(r.deleted, false);
  assert.equal(rec.searches.length, 0);
});

test("delete: without UIDPLUS soft-deletes exact UIDs (no unsafe global EXPUNGE)", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    searchResults: [[42]],
  });
  const r = await executeDraftDelete(client, DELETE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, true);
  assert.equal(rec.deletes.length, 0);
  assert.deepEqual(rec.softDeletes[0], [42]);
});

test("delete: UIDVALIDITY mismatch still safe (uses header-derived UIDs, not client UID)", async () => {
  // Client claims uidValidity=999 for uid=42, actual mailbox uidValidity=1000.
  // Header search finds [77] in the CURRENT mailbox — we must expunge that,
  // and MUST NOT use uid=42 blindly.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    searchResults: [[77]],
  });
  const r = await executeDraftDelete(client, {
    ...DELETE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "999" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.deletes.length, 1);
  assert.deepEqual(rec.deletes[0], [77]);
});

test("delete: only touches the account's own Drafts folder (never a caller-supplied path)", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[42]],
  });
  await executeDraftDelete(client, {
    ...DELETE_INPUT,
    // Attacker-shaped previousRef pointing at INBOX. Server MUST ignore it
    // and operate on the resolved Drafts path.
    previousRef: { folderPath: "INBOX", uid: 1, uidValidity: "1000" },
  });
  assert.deepEqual(rec.opens, ["Drafts"]);
  assert.equal(rec.opens.includes("INBOX"), false);
});

test("delete: modern header-based Draft still deletes", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    searchResults: [[77]],
  });
  const r = await executeDraftDelete(client, DELETE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, true);
  assert.deepEqual(rec.deletes[0], [77]);
});

test("delete: legacy headerless Draft deletes by valid previousRef", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    searchResults: [[]],
  });
  const r = await executeDraftDelete(client, {
    ...DELETE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, true);
  assert.deepEqual(rec.deletes[0], [42]);
  assert.equal(rec.softDeletes.length, 0);
});

test("delete: stale UIDVALIDITY previousRef is NOT trusted", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    searchResults: [[]],
  });
  const r = await executeDraftDelete(client, {
    ...DELETE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "999" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, false);
  assert.equal(rec.deletes.length, 0);
  assert.equal(rec.softDeletes.length, 0);
});

test("delete: wrong folderPath previousRef is NOT trusted", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    searchResults: [[]],
  });
  const r = await executeDraftDelete(client, {
    ...DELETE_INPUT,
    previousRef: { folderPath: "INBOX", uid: 1, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, false);
  assert.equal(rec.deletes.length, 0);
  assert.equal(rec.softDeletes.length, 0);
});

test("delete: unrelated Draft is never deleted without header or valid previousRef", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    searchResults: [[]],
  });
  const r = await executeDraftDelete(client, {
    ...DELETE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 9999, uidValidity: "888" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deleted, false);
  assert.equal(rec.deletes.length, 0);
  assert.equal(rec.softDeletes.length, 0);
});

// ---------- Contract / safety tests -----------------------------------------

test("contract: DraftSavePayload rejects oversize body (>5 MiB single body)", () => {
  const huge = "x".repeat(5 * 1024 * 1024 + 1);
  const parsed = DraftSavePayloadSchema.safeParse({
    account: ACCT,
    password: "pw",
    draftId: DRAFT_ID,
    revisionId: REVISION_ID,
    bodyHtml: huge,
  });
  assert.equal(parsed.success, false);
});

test("contract: DraftSavePayload rejects combined bodies over the total cap", () => {
  const near = "x".repeat(5 * 1024 * 1024);
  const parsed = DraftSavePayloadSchema.safeParse({
    account: ACCT,
    password: "pw",
    draftId: DRAFT_ID,
    revisionId: REVISION_ID,
    bodyHtml: near,
    bodyText: near + "y", // 5MiB + 5MiB + 1 > 10MiB
  });
  assert.equal(parsed.success, false);
});

test("safety: IMAP failure surfaces coarse code and no PII in the result", async () => {
  const { client } = mkClient({
    mailboxes: [box("Drafts")],
    appendFail: true,
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, false);
  if (r.ok) return;
  const serialized = JSON.stringify(r);
  assert.equal(r.error, "APPEND_FAILED");
  // PII / secret leak guard: never surface subject, body, recipient email,
  // password, or provider-specific error strings.
  assert.ok(!serialized.includes(BASE_INPUT.subject));
  assert.ok(!serialized.includes("draft body"));
  assert.ok(!serialized.includes("dest@example.com"));
  assert.ok(!serialized.includes("pw"));
  assert.ok(!serialized.toLowerCase().includes("append failed"));
});

// ---------- M2.1 — Concurrent Draft Safety ---------------------------------
//
// The keyed mutex + canonical-max selection convert concurrent races on the
// same (account, draftId) into a serialized pipeline that always converges
// to exactly one canonical copy — the highest UID.

test("UIDPLUS: APPENDUID is canonical and the redundant post-APPEND search is skipped", async () => {
  // UIDPLUS returns a real APPENDUID, which is authoritative. No redundant
  // post-APPEND header SEARCH runs on the UIDPLUS path.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    appendUid: 100,
    searchResults: [[], [100, 150, 200]], // 2nd entry only used on non-UIDPLUS
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.uid, 100, "canonical uid must be the APPENDUID");
  assert.equal(rec.searches.length, 1, "UIDPLUS path performs only the pre-APPEND probe");
  assert.equal(rec.deletes.length, 0, "no stale copies to expunge");
});

test("canonical: our own APPEND is canonical when it is the highest UID", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    appendUid: 300,
    searchResults: [
      [42, 200],
      [42, 200, 300],
    ], // pre-probe has 42+200; ours=300
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.uid, 300);
  assert.deepEqual(
    [...rec.deletes[0]].sort((a, b) => a - b),
    [42, 200],
  );
});

// -- Mutex-driven concurrency scenarios --------------------------------------
// Shared fake IMAP "server" the fake clients read/write against so we can
// exercise the mutex across independent saveDraft calls.

interface FakeServer {
  hasUidPlus: boolean;
  uidValidity: string;
  mailboxes: Array<{ path: string; specialUse?: string }>;
  /** Map of uid -> draftId header. Represents the Drafts mailbox contents. */
  messages: Map<number, string>;
  nextUid: number;
  appendCount: number;
  deleteCount: number;
}

function mkServer(over: Partial<FakeServer> = {}): FakeServer {
  return {
    hasUidPlus: true,
    uidValidity: "1000",
    mailboxes: [box("Drafts")],
    messages: new Map(),
    nextUid: 100,
    appendCount: 0,
    deleteCount: 0,
    ...over,
  };
}

function mkSharedDeps(
  server: FakeServer,
  hook?: {
    beforeAppend?: () => Promise<void>;
    afterAppend?: () => Promise<void>;
  },
): DraftDeps {
  return {
    createImapDraftClient: () => ({
      async connect() {},
      async list() {
        return server.mailboxes as unknown as never;
      },
      hasUidPlus() {
        return server.hasUidPlus;
      },
      async openWithLock() {
        return { uidValidity: server.uidValidity, release: () => {} };
      },
      async searchByHeader(_name, value) {
        const out: number[] = [];
        for (const [uid, id] of server.messages) if (id === value) out.push(uid);
        return out.sort((a, b) => a - b);
      },
      async append(_path, raw) {
        if (hook?.beforeAppend) await hook.beforeAppend();
        const mime = (await readStream(raw)).toString("utf8");
        // Pull the draftId out of the header we know is present.
        const m = mime.match(new RegExp(`${DRAFT_ID_HEADER}:\\s*([^\\r\\n]+)`, "i"));
        const id = m ? m[1].trim() : "";
        const uid = server.nextUid++;
        server.messages.set(uid, id);
        server.appendCount++;
        if (hook?.afterAppend) await hook.afterAppend();
        return { uid: server.hasUidPlus ? uid : null, uidValidity: server.uidValidity };
      },
      async deleteByUid(uids) {
        for (const u of uids) server.messages.delete(u);
        server.deleteCount++;
        return true;
      },
      async softDeleteByUid(uids) {
        for (const u of uids) server.messages.delete(u);
        server.deleteCount++;
        return true;
      },
      hasMove() {
        return false;
      },
      async moveByUid() {
        return true;
      },
      async logout() {},
    }),
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
}

test("mutex: two concurrent UIDPLUS saves converge to exactly one canonical copy (highest UID)", async () => {
  const server = mkServer();
  const deps = mkSharedDeps(server);
  const [r1, r2] = await Promise.all([
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  // Exactly one message remains, and its UID equals the canonical one.
  assert.equal(server.messages.size, 1, "folder MUST contain exactly one draft");
  const survivingUid = [...server.messages.keys()][0];
  // The later caller's returned uid IS the surviving canonical.
  if (r1.ok && r2.ok) {
    const uids = [r1.uid, r2.uid].filter((u): u is number => typeof u === "number");
    assert.ok(uids.includes(survivingUid), "at least one response references the canonical UID");
    // Highest UID observed anywhere equals the survivor.
    assert.equal(Math.max(...uids), survivingUid);
  }
  // Mutex map fully drained.
  assert.equal(draftMutexInflight(), 0, "mutex map MUST be empty after both calls settle");
});

test("sequential autosaves with different revisions keep exactly one provider Draft", async () => {
  const server = mkServer();
  const deps = mkSharedDeps(server);
  const revisionIds = [
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    "cccccccc-dddd-4eee-8fff-000000000000",
  ];

  for (const revisionId of revisionIds) {
    const r = await saveDraft(ACCT, "pw", { ...BASE_INPUT, revisionId }, deps);
    assert.equal(r.ok, true);
  }

  assert.equal(server.messages.size, 1, "sequential autosaves MUST converge to one copy");
  assert.equal(draftMutexInflight(), 0, "mutex map MUST be empty after sequential saves settle");
});

test("mutex: two concurrent UIDPLUS saves NEVER delete each other into an empty folder", async () => {
  const server = mkServer();
  const deps = mkSharedDeps(server);
  const results = await Promise.all([
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
  ]);
  for (const r of results) assert.equal(r.ok, true);
  assert.equal(server.messages.size, 1);
  assert.equal(draftMutexInflight(), 0);
});

test("mutex: without UIDPLUS or MOVE, concurrent saves converge to one canonical via soft-delete", async () => {
  const server = mkServer({ hasUidPlus: false });
  const deps = mkSharedDeps(server);
  const [r1, r2] = await Promise.all([
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
    saveDraft(ACCT, "pw", BASE_INPUT, deps),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(server.messages.size, 1, "exactly one canonical draft remains");
  assert.equal(server.appendCount, 2, "both saves APPEND on the soft-delete fallback");
  assert.equal(draftMutexInflight(), 0);
});

test("mutex: is released after a failure path (map cleaned up even when APPEND throws)", async () => {
  const server = mkServer();
  const deps: DraftDeps = {
    ...mkSharedDeps(server),
    createImapDraftClient: () => ({
      async connect() {},
      async list() {
        return server.mailboxes as unknown as never;
      },
      hasUidPlus() {
        return true;
      },
      async openWithLock() {
        return { uidValidity: "1000", release: () => {} };
      },
      async searchByHeader() {
        return [];
      },
      async append() {
        throw new Error("boom");
      },
      async deleteByUid() {
        return true;
      },
      hasMove() {
        return false;
      },
      async moveByUid() {
        return true;
      },
      async logout() {},
    }),
  };
  const r = await saveDraft(ACCT, "pw", BASE_INPUT, deps);
  assert.equal(r.ok, false);
  assert.equal(draftMutexInflight(), 0, "mutex MUST be drained even on APPEND failure");
});

test("mutex: retry after cleanup interruption converges to a single canonical copy", async () => {
  const server = mkServer();
  // Round 1: APPEND lands, but search-post-APPEND throws → no cleanup runs.
  const factoryFactory = (throwOnSecondSearch: boolean): DraftDeps => ({
    createImapDraftClient: () => {
      let searchCalls = 0;
      return {
        async connect() {},
        async list() {
          return server.mailboxes as unknown as never;
        },
        hasUidPlus() {
          return true;
        },
        async openWithLock() {
          return { uidValidity: "1000", release: () => {} };
        },
        async searchByHeader(_n, v) {
          searchCalls++;
          if (throwOnSecondSearch && searchCalls === 2) throw new Error("search boom");
          const out: number[] = [];
          for (const [uid, id] of server.messages) if (id === v) out.push(uid);
          return out.sort((a, b) => a - b);
        },
        async append(_p, raw) {
          const m = (await readStream(raw))
            .toString("utf8")
            .match(new RegExp(`${DRAFT_ID_HEADER}:\\s*([^\\r\\n]+)`, "i"));
          const uid = server.nextUid++;
          server.messages.set(uid, m ? m[1].trim() : "");
          return { uid, uidValidity: "1000" };
        },
        async deleteByUid(uids) {
          for (const u of uids) server.messages.delete(u);
          return true;
        },
        hasMove() {
          return false;
        },
        async moveByUid() {
          return true;
        },
        async logout() {},
      };
    },
    now: () => new Date(),
  });
  const r1 = await saveDraft(ACCT, "pw", BASE_INPUT, factoryFactory(true));
  assert.equal(r1.ok, true);
  assert.equal(server.messages.size, 1, "APPEND landed even though cleanup search threw");

  // Round 2 (retry): normal search runs, canonical=max, stale deleted →
  // still exactly one message.
  const r2 = await saveDraft(ACCT, "pw", BASE_INPUT, factoryFactory(false));
  assert.equal(r2.ok, true);
  assert.equal(server.messages.size, 1, "retry MUST converge to exactly one canonical copy");
  assert.equal(draftMutexInflight(), 0);
});

test("mutex: different UIDVALIDITY between pre-probe and APPEND does not leak stale UIDs", async () => {
  // Simulate a UIDVALIDITY bump between the pre-APPEND probe and the
  // post-APPEND search. The canonical selection MUST rely on the freshly
  // searched UIDs from the CURRENT mailbox, never the pre-probe ones.
  let opens = 0;
  const server = mkServer();
  server.messages.set(9999, DRAFT_ID); // stale ghost from an old UIDVALIDITY
  const deps: DraftDeps = {
    createImapDraftClient: () => ({
      async connect() {},
      async list() {
        return server.mailboxes as unknown as never;
      },
      hasUidPlus() {
        return true;
      },
      async openWithLock() {
        opens++;
        // First open (probe) reports uidValidity=1000; after APPEND we
        // report uidValidity=2000 and the search space resets.
        if (opens === 1) return { uidValidity: "1000", release: () => {} };
        server.messages.delete(9999); // uidvalidity bump wiped the old rows
        return { uidValidity: "2000", release: () => {} };
      },
      async searchByHeader(_n, v) {
        const out: number[] = [];
        for (const [uid, id] of server.messages) if (id === v) out.push(uid);
        return out.sort((a, b) => a - b);
      },
      async append(_p, raw) {
        const m = (await readStream(raw))
          .toString("utf8")
          .match(new RegExp(`${DRAFT_ID_HEADER}:\\s*([^\\r\\n]+)`, "i"));
        const uid = 50; // NEW uidvalidity => low uid space
        server.messages.set(uid, m ? m[1].trim() : "");
        return { uid, uidValidity: "2000" };
      },
      async deleteByUid(uids) {
        for (const u of uids) server.messages.delete(u);
        return true;
      },
      hasMove() {
        return false;
      },
      async moveByUid() {
        return true;
      },
      async logout() {},
    }),
    now: () => new Date(),
  };
  const r = await saveDraft(ACCT, "pw", BASE_INPUT, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.uidValidity, "2000", "returned uidValidity MUST reflect the current mailbox");
  assert.equal(
    r.uid,
    50,
    "canonical uid comes from the freshly-appended message under new uidvalidity",
  );
  // Old 9999 UID from the previous uidvalidity MUST NOT be treated as stale-and-deleted.
  assert.equal(server.messages.has(9999), false);
});

// ---------- M4-A — Legacy Draft Support (previousRef without header) --------
//
// Old drafts saved before MAILMAESTRO_DRAFT_APPEND_R1 don't carry the
// X-MailMaestro-Draft-ID header, so header-search alone can never find them.
// M4-A requires trusting a caller-supplied previousRef ONLY under strict
// invariants: same resolved Drafts path, same UIDVALIDITY, UIDPLUS supported,
// APPEND happens BEFORE delete, and no global EXPUNGE.

test("M4-A: legacy draft (no header) + valid previousRef → APPEND then delete old UID", async () => {
  // Pre-APPEND probe: [] (legacy has no header). previousRef forces replace
  // mode. Post-APPEND search: [200] (only the new one has the header).
  const events: string[] = [];
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const origAppend = client.append.bind(client);
  const origDelete = client.deleteByUid.bind(client);
  client.append = async (p, r, f) => {
    events.push("append");
    return origAppend(p, r, f);
  };
  client.deleteByUid = async (u) => {
    events.push(`delete:${u.join(",")}`);
    return origDelete(u);
  };
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(events, ["append", "delete:42"], "APPEND must land before delete of legacy UID");
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.deletes.length, 1);
  assert.deepEqual(rec.deletes[0], [42]);
});

test("M4-A: legacy APPEND failure leaves legacy previousRef UID untouched", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    appendFail: true,
    searchResults: [[]], // legacy: no header match
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  // Note: replace mode + no UIDPLUS refuses pre-APPEND. Here UIDPLUS defaults
  // to true so we DO reach APPEND, which then fails. Old copy MUST be safe.
  assert.equal(r.error, "APPEND_FAILED");
  assert.equal(rec.deletes.length, 0, "MUST NOT touch legacy UID when APPEND fails");
});

test("M4-A: UIDVALIDITY mismatch on previousRef → APPEND ok, legacy UID NOT deleted", async () => {
  // Caller's previousRef.uidValidity=999 but current mailbox=1000. The old
  // UID cannot be trusted → must not be deleted. APPEND still succeeds.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "999" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.deletes.length, 0, "UIDVALIDITY mismatch MUST prevent legacy UID deletion");
});

test("M4-A: previousRef.folderPath ≠ resolved Drafts path → legacy UID NOT deleted", async () => {
  // Attacker-shaped previousRef pointing at INBOX. Even if the UIDVALIDITY
  // matches, the folder path mismatch must veto any delete.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "INBOX", uid: 1, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.deletes.length, 0, "previousRef for non-Drafts folder MUST be ignored");
  // Server only opened its own resolved Drafts folder — INBOX never touched.
  assert.equal(
    rec.opens.every((p) => p === "Drafts"),
    true,
  );
});

test("M4-A: non-existent previousRef UID cannot delete an unrelated message (same UIDVALIDITY)", async () => {
  // IMAP guarantees UIDs are never reused within one UIDVALIDITY, so a
  // delete-by-UID for a UID that no longer exists is a harmless no-op. We
  // exercise the code path and assert it only ever issues the exact UID we
  // asked for (never a wildcard/global EXPUNGE).
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 9999, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.deletes.length, 1);
  assert.deepEqual(rec.deletes[0], [9999], "delete must target exactly the previousRef UID");
});

test("M4-A: previousRef without UIDPLUS APPENDs then soft-deletes the legacy UID", async () => {
  // Belt-and-braces on top of the soft-delete fallback: legacy drafts carry no
  // header, so previousRef drives the stale candidate. No global EXPUNGE.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    hasMove: false,
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.appends.length, 1, "MUST APPEND on the legacy soft-delete path");
  assert.equal(rec.deletes.length, 0, "no UID EXPUNGE without UIDPLUS");
  assert.deepEqual(rec.softDeletes[0], [42], "legacy UID soft-deleted exactly");
});

test("M4-A: legacy previousRef with mutex — retry after crash converges to one canonical", async () => {
  // Round 1: legacy draft exists at UID 42 (no header); previousRef points
  // at it; APPEND lands at 100; delete of 42 happens.
  const server = mkServer();
  server.messages.set(42, ""); // legacy: no draftId header
  const deps = mkSharedDeps(server);
  const r1 = await saveDraft(
    ACCT,
    "pw",
    {
      ...BASE_INPUT,
      previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
    },
    deps,
  );
  assert.equal(r1.ok, true);
  assert.equal(server.messages.has(42), false, "legacy UID must be deleted");
  assert.equal(server.messages.size, 1, "exactly one canonical copy after legacy replace");

  // Round 2 (retry with same previousRef, but the legacy UID is already
  // gone). Must still converge to a single copy.
  const r2 = await saveDraft(
    ACCT,
    "pw",
    {
      ...BASE_INPUT,
      previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
    },
    deps,
  );
  assert.equal(r2.ok, true);
  assert.equal(server.messages.size, 1, "retry MUST converge to exactly one canonical copy");
  assert.equal(draftMutexInflight(), 0);
});

// ---------- Capability detection --------------------------------------------
//
// Root cause of the SAFE_DRAFT_REPLACE_UNSUPPORTED regression: ImapFlow's
// `client.capabilities` is a `Map<string, boolean | number>`, not an iterable
// of strings. Iterating it yields `[key, value]` tuples that stringified to
// e.g. "UIDPLUS,true", so the old check never matched. These tests lock the
// helper against every shape we might see in the wild.

test("capability: Map with UIDPLUS true → true", () => {
  const caps = new Map<string, boolean | number>([["UIDPLUS", true]]);
  assert.equal(hasImapCapability(caps, "UIDPLUS"), true);
});

test("capability: Map case-insensitive lookup (lowercase key)", () => {
  const caps = new Map<string, boolean | number>([["uidplus", true]]);
  assert.equal(hasImapCapability(caps, "UIDPLUS"), true);
});

test("capability: Map with UIDPLUS explicitly false → false", () => {
  const caps = new Map<string, boolean | number>([["UIDPLUS", false]]);
  assert.equal(hasImapCapability(caps, "UIDPLUS"), false);
});

test("capability: Map without UIDPLUS → false", () => {
  const caps = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["IDLE", true],
  ]);
  assert.equal(hasImapCapability(caps, "UIDPLUS"), false);
});

test("capability: Set with UIDPLUS → true (defensive compat)", () => {
  const caps = new Set(["UIDPLUS", "IDLE"]);
  assert.equal(hasImapCapability(caps, "UIDPLUS"), true);
});

test("capability: Map with MOVE → hasMove true", () => {
  const caps = new Map<string, boolean | number>([["MOVE", true]]);
  assert.equal(hasImapCapability(caps, "MOVE"), true);
});

test("capability: never produces [key,value] false negative (Map iteration guard)", () => {
  // Prove the failure mode is gone: if we mistakenly stringified the entry
  // pair, `String(["UIDPLUS", true])` === "UIDPLUS,true" which does NOT
  // equal "UIDPLUS". The helper MUST still find UIDPLUS.
  const caps = new Map<string, boolean | number>([["UIDPLUS", true]]);
  for (const entry of caps) {
    assert.notEqual(String(entry).toUpperCase(), "UIDPLUS", "sanity: entry is [k,v]");
  }
  assert.equal(hasImapCapability(caps, "UIDPLUS"), true);
});

test("capability: undefined / null / empty → false", () => {
  assert.equal(hasImapCapability(undefined, "UIDPLUS"), false);
  assert.equal(hasImapCapability(null, "UIDPLUS"), false);
  assert.equal(hasImapCapability(new Map(), "UIDPLUS"), false);
});

// ---------- resolveTrashPath ------------------------------------------------

test("resolveTrashPath prefers SPECIAL-USE \\Trash over any well-known name", () => {
  const boxes = [box("INBOX"), box("Bin/Old", "\\Trash"), box("Trash")];
  assert.equal(resolveTrashPath(boxes as unknown as never), "Bin/Old");
});

test("resolveTrashPath matches Deleted Items / Deleted / Gmail Trash / Bin", () => {
  assert.equal(resolveTrashPath([box("Deleted Items")] as unknown as never), "Deleted Items");
  assert.equal(resolveTrashPath([box("Deleted")] as unknown as never), "Deleted");
  assert.equal(resolveTrashPath([box("[Gmail]/Trash")] as unknown as never), "[Gmail]/Trash");
  assert.equal(resolveTrashPath([box("[Gmail]/Bin")] as unknown as never), "[Gmail]/Bin");
});

test("resolveTrashPath returns undefined when no Trash-like folder exists", () => {
  const boxes = [box("INBOX"), box("Drafts"), box("Sent")];
  assert.equal(resolveTrashPath(boxes as unknown as never), undefined);
});

// ---------- MOVE fallback (no UIDPLUS, MOVE + Trash present) ---------------

test("MOVE fallback: no UIDPLUS + MOVE + Trash → APPEND then MOVE stale to Trash", async () => {
  const events: string[] = [];
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    appendUid: 200,
    searchResults: [[42], [42, 200]],
  });
  const origAppend = client.append.bind(client);
  const origMove = client.moveByUid.bind(client);
  client.append = async (p, r, f) => {
    events.push("append");
    return origAppend(p, r, f);
  };
  client.moveByUid = async (u, d) => {
    events.push(`move:${u.join(",")}->${d}`);
    return origMove(u, d);
  };
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  assert.deepEqual(events, ["append", "move:42->Trash"]);
  assert.equal(rec.deletes.length, 0, "MOVE path MUST NOT call deleteByUid");
  assert.equal(rec.moves.length, 1);
  assert.equal(rec.moves[0].dest, "Trash");
});

test("MOVE fallback: canonical (highest UID) is NEVER moved to Trash", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    appendUid: 300,
    searchResults: [
      [100, 200],
      [100, 200, 300],
    ],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.uid, 300, "canonical MUST be the highest UID");
  assert.equal(rec.moves.length, 1);
  assert.equal(rec.moves[0].uids.includes(300), false, "canonical MUST NOT be moved");
  assert.deepEqual(
    [...rec.moves[0].uids].sort((a, b) => a - b),
    [100, 200],
  );
});

test("MOVE fallback: legacy previousRef (no header) is moved when guards pass", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.moves.length, 1);
  assert.deepEqual(rec.moves[0].uids, [42]);
  assert.equal(rec.moves[0].dest, "Trash");
  assert.equal(rec.deletes.length, 0);
});

test("MOVE fallback: previousRef with wrong folder path is NOT moved", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "INBOX", uid: 1, uidValidity: "1000" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.moves.length, 0, "wrong folderPath MUST veto the MOVE");
});

test("MOVE fallback: UIDVALIDITY mismatch on previousRef → not moved", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    uidValidity: "1000",
    appendUid: 200,
    searchResults: [[], [200]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "999" },
  });
  assert.equal(r.ok, true);
  assert.equal(rec.moves.length, 0);
});

test("MOVE fallback: MOVE failure after APPEND does NOT lose the new copy", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    moveFail: true,
    appendUid: 200,
    searchResults: [[42], [42, 200]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true, "MOVE failure MUST NOT roll back APPEND");
  if (!r.ok) return;
  assert.equal(r.uid, 200);
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.deletes.length, 0, "MUST NEVER fall back to global EXPUNGE");
});

test("MOVE fallback: retry after MOVE failure converges to a single canonical", async () => {
  // Simulate a server with MOVE but no UIDPLUS via mkSharedDeps overrides.
  interface TrashServer {
    drafts: Map<number, string>;
    trash: Map<number, string>;
    nextUid: number;
  }
  const server: TrashServer = {
    drafts: new Map([[42, DRAFT_ID]]), // legacy prior copy
    trash: new Map(),
    nextUid: 100,
  };
  let moveShouldFail = true;
  const deps: DraftDeps = {
    createImapDraftClient: () => ({
      async connect() {},
      async list() {
        return [box("Drafts"), box("Trash")] as unknown as never;
      },
      hasUidPlus() {
        return false;
      },
      hasMove() {
        return true;
      },
      async openWithLock() {
        return { uidValidity: "1000", release: () => {} };
      },
      async searchByHeader(_n, v) {
        const out: number[] = [];
        for (const [uid, id] of server.drafts) if (id === v) out.push(uid);
        return out.sort((a, b) => a - b);
      },
      async append(_p, raw) {
        const m = (await readStream(raw))
          .toString("utf8")
          .match(new RegExp(`${DRAFT_ID_HEADER}:\\s*([^\\r\\n]+)`, "i"));
        const uid = server.nextUid++;
        server.drafts.set(uid, m ? m[1].trim() : "");
        return { uid: null, uidValidity: "1000" };
      },
      async deleteByUid() {
        throw new Error("deleteByUid MUST NOT be called on MOVE path");
      },
      async moveByUid(uids, dest) {
        if (moveShouldFail) throw new Error("move boom");
        for (const u of uids) {
          const v = server.drafts.get(u);
          if (v !== undefined) {
            server.drafts.delete(u);
            server.trash.set(u, v);
          }
        }
        void dest;
        return true;
      },
      async logout() {},
    }),
    now: () => new Date(),
  };
  const r1 = await saveDraft(ACCT, "pw", BASE_INPUT, deps);
  assert.equal(r1.ok, true, "first save succeeds despite MOVE failure");
  assert.equal(server.drafts.size, 2, "old + new both present after MOVE failure");

  moveShouldFail = false;
  const r2 = await saveDraft(ACCT, "pw", BASE_INPUT, deps);
  assert.equal(r2.ok, true);
  assert.equal(server.drafts.size, 1, "retry converges to exactly one canonical in Drafts");
  assert.equal(draftMutexInflight(), 0);
});

test("neither UIDPLUS nor MOVE: APPEND then soft-delete stale (no global EXPUNGE)", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: false,
    appendUid: 100,
    searchResults: [[42], [42, 100]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.moves.length, 0);
  assert.equal(rec.deletes.length, 0);
  assert.deepEqual(rec.softDeletes[0], [42]);
});

test("MOVE without a safe Trash target falls back to soft-delete (never global EXPUNGE)", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")], // no Trash-like folder
    hasUidPlus: false,
    hasMove: true,
    appendUid: 100,
    searchResults: [[42], [42, 100]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(rec.appends.length, 1);
  assert.equal(rec.moves.length, 0);
  assert.deepEqual(rec.softDeletes[0], [42]);
});

test("MOVE fallback path MUST NOT call deleteByUid at any point", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts"), box("Trash")],
    hasUidPlus: false,
    hasMove: true,
    appendUid: 200,
    searchResults: [[42], [42, 200]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true);
  assert.equal(rec.deletes.length, 0);
});

test("safety: no globalExpunge symbol / no EXPUNGE call surface exists on the client", () => {
  // The ImapDraftClient contract MUST NOT expose a global EXPUNGE method.
  // If someone adds one, this test fires and the reviewer must justify it.
  const { client } = mkClient({ mailboxes: [box("Drafts")] });
  const surface = Object.keys(client);
  for (const name of surface) {
    assert.equal(/expunge/i.test(name), false, `unexpected expunge method: ${name}`);
    assert.equal(/globalExpunge/i.test(name), false);
  }
});

test("UIDPLUS path is unchanged: Map-based capability makes replace-mode succeed", async () => {
  // End-to-end proof that the Map fix restores the UIDPLUS path: use the
  // production hasImapCapability against a real ImapFlow-shaped Map and
  // verify replace-mode APPENDs + deleteByUid (never SAFE_DRAFT_REPLACE_UNSUPPORTED).
  const caps = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["UIDPLUS", true],
    ["IDLE", true],
  ]);
  assert.equal(hasImapCapability(caps, "UIDPLUS"), true);

  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: true, // simulates the fix taking effect
    appendUid: 200,
    searchResults: [[42], [42, 200]],
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, true, "must not return SAFE_DRAFT_REPLACE_UNSUPPORTED");
  assert.equal(rec.appends.length, 1);
  assert.deepEqual(rec.deletes[0], [42]);
});
