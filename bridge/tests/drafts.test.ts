/**
 * MAILMAESTRO_DRAFT_APPEND_R1 — Bridge Drafts contract regression suite.
 *
 * These tests lock every guarantee promised by bridge/src/drafts.ts. They
 * use dependency-injected IMAP fakes exclusively — no network, no real
 * imapflow, no MailComposer stubbing (buildMime runs for real so we can
 * assert the X-MailMaestro-Draft-ID header actually reaches the wire).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDraftsPath } from "../src/smtp.js";
import {
  executeDraftSave,
  executeDraftDelete,
  DRAFT_ID_HEADER,
  DraftSavePayloadSchema,
  type ImapDraftClient,
  type DraftSavePayload,
  type DraftDeletePayload,
} from "../src/drafts.js";
import type { MailAccount } from "../src/types.js";

// ---------- resolveDraftsPath ------------------------------------------------

function box(path: string, specialUse?: string): any {
  return specialUse ? { path, specialUse } : { path };
}

test("resolveDraftsPath prefers SPECIAL-USE \\Drafts over any well-known name", () => {
  const boxes = [box("INBOX"), box("Custom/WIP", "\\Drafts"), box("Drafts"), box("[Gmail]/Drafts")];
  assert.equal(resolveDraftsPath(boxes as any), "Custom/WIP");
});

test("resolveDraftsPath falls back to well-known 'Drafts' when SPECIAL-USE absent", () => {
  const boxes = [box("INBOX"), box("Sent"), box("Drafts"), box("Trash")];
  assert.equal(resolveDraftsPath(boxes as any), "Drafts");
});

test("resolveDraftsPath recognizes [Gmail]/Drafts", () => {
  const boxes = [box("INBOX"), box("[Gmail]/Drafts")];
  assert.equal(resolveDraftsPath(boxes as any), "[Gmail]/Drafts");
});

test("resolveDraftsPath returns undefined when no Drafts-like folder exists", () => {
  const boxes = [box("INBOX"), box("Trash")];
  assert.equal(resolveDraftsPath(boxes as any), undefined);
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

const BASE_INPUT: DraftSavePayload = DraftSavePayloadSchema.parse({
  account: ACCT,
  password: "pw",
  draftId: DRAFT_ID,
  to: [{ name: "You", email: "dest@example.com" }],
  subject: "Draft subject",
  bodyText: "draft body",
});

interface FakeOpts {
  mailboxes: Array<{ path: string; specialUse?: string }>;
  uidValidity?: string;
  hasUidPlus?: boolean;
  appendUid?: number;
  appendFail?: boolean;
  searchResults?: number[][]; // per-call
  searchFail?: boolean;
  deleteFail?: boolean;
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
  logouts: number;
  hasUidPlusCalls: number;
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
    logouts: 0,
    hasUidPlusCalls: 0,
  };
  let searchIdx = 0;
  const client: ImapDraftClient = {
    async connect() {
      rec.connects++;
      if (opts.connectFail) throw new Error("connect failed");
    },
    async list() {
      rec.lists++;
      if (opts.listFail) throw new Error("list failed");
      return opts.mailboxes as any;
    },
    hasUidPlus() {
      rec.hasUidPlusCalls++;
      return opts.hasUidPlus ?? true;
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
      const result = opts.searchResults?.[searchIdx] ?? [];
      searchIdx++;
      return result;
    },
    async append(path, raw, flags) {
      rec.appends.push({ path, raw, flags });
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

test("save: replace mode without UIDPLUS is refused BEFORE any APPEND", async () => {
  // Prior copy exists AND server lacks UIDPLUS → SAFE_DRAFT_REPLACE_UNSUPPORTED
  // WITHOUT ever appending (closes the "append then can't delete" race).
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    searchResults: [[42]], // pre-APPEND probe finds an existing copy
  });
  const r = await executeDraftSave(client, BASE_INPUT);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "SAFE_DRAFT_REPLACE_UNSUPPORTED");
  assert.equal(rec.appends.length, 0, "MUST NOT APPEND when replace is unsafe");
  assert.equal(rec.deletes.length, 0);
});

test("save: explicit previousRef without UIDPLUS is refused BEFORE APPEND", async () => {
  // Caller signals a prior copy via previousRef even though the server search
  // returned []. That STILL forces replace-mode and STILL requires UIDPLUS.
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    searchResults: [[]],
  });
  const r = await executeDraftSave(client, {
    ...BASE_INPUT,
    previousRef: { folderPath: "Drafts", uid: 42, uidValidity: "1000" },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "SAFE_DRAFT_REPLACE_UNSUPPORTED");
  assert.equal(rec.appends.length, 0);
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

function attachmentInput(attachments: Array<{ filename: string; content: Buffer; contentType?: string }>): DraftSavePayload {
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
      { filename: "invoice.pdf", content: Buffer.from("PDF-BYTES-XYZ"), contentType: "application/pdf" },
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

test("delete: refuses when server lacks UIDPLUS (no unsafe global EXPUNGE)", async () => {
  const { client, rec } = mkClient({
    mailboxes: [box("Drafts")],
    hasUidPlus: false,
    searchResults: [[42]],
  });
  const r = await executeDraftDelete(client, DELETE_INPUT);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "UIDPLUS_UNSUPPORTED");
  assert.equal(rec.deletes.length, 0);
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

// ---------- Contract / safety tests -----------------------------------------

test("contract: DraftSavePayload rejects oversize body (>5 MiB single body)", () => {
  const huge = "x".repeat(5 * 1024 * 1024 + 1);
  const parsed = DraftSavePayloadSchema.safeParse({
    account: ACCT,
    password: "pw",
    draftId: DRAFT_ID,
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
