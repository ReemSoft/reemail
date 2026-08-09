// Regression tests for the Sent-copy resolution path in the Bridge SMTP
// module. Guards against silently dropping SPECIAL-USE detection or the
// well-known Sent-folder fallback list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createMimeSpool } from "../src/mime-spool.js";
import { resolveSentPath } from "../src/smtp.js";

// The imapflow ListResponse we care about is loosely shaped: { path,
// specialUse? }. Cast through unknown so we don't have to import the full
// type surface for a shape assertion.
function box(path: string, specialUse?: string): any {
  return specialUse ? { path, specialUse } : { path };
}

test("resolveSentPath prefers SPECIAL-USE \\Sent over any well-known name", () => {
  const boxes = [
    box("INBOX"),
    box("Custom/OutgoingCopies", "\\Sent"),
    box("Sent"),
    box("[Gmail]/Sent"),
  ];
  assert.equal(resolveSentPath(boxes as any), "Custom/OutgoingCopies");
});

test("resolveSentPath falls back to well-known 'Sent' when SPECIAL-USE is absent", () => {
  const boxes = [box("INBOX"), box("Drafts"), box("Sent"), box("Trash")];
  assert.equal(resolveSentPath(boxes as any), "Sent");
});

test("resolveSentPath recognizes [Gmail]/Sent Mail", () => {
  const boxes = [box("INBOX"), box("[Gmail]/Sent Mail"), box("[Gmail]/Trash")];
  assert.equal(resolveSentPath(boxes as any), "[Gmail]/Sent Mail");
});

test("resolveSentPath recognizes localized Arabic 'المرسلة'", () => {
  const boxes = [box("INBOX"), box("المرسلة"), box("المهملات")];
  assert.equal(resolveSentPath(boxes as any), "المرسلة");
});

test("resolveSentPath is case-insensitive on well-known names", () => {
  const boxes = [box("INBOX"), box("sent")];
  assert.equal(resolveSentPath(boxes as any), "sent");
});

test("resolveSentPath returns undefined when no Sent-like folder exists (APPEND is skipped)", () => {
  const boxes = [box("INBOX"), box("Trash"), box("Drafts")];
  assert.equal(resolveSentPath(boxes as any), undefined);
});

// ============================================================================
// Full sendMessage regression tests via dependency injection.
// These tests MUST fail if Search-then-APPEND, duplicate protection, raw-MIME
// reuse, retry timing, or Sent-folder resolution ever regress.
// ============================================================================
import {
  sendMessage,
  sendMessageFast,
  type SendMessageDeps,
  type SmtpTransport,
  type ImapSentClient,
} from "../src/smtp.js";
import type { MailAccount } from "../src/types.js";

const ACCT: MailAccount = {
  id: "acct-1",
  email_address: "user@example.com",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_secure: true,
  display_name: "User",
} as unknown as MailAccount;

interface Recorder {
  sendMailCalls: number;
  smtpClosed: number;
  imapConnected: number;
  listCalls: number;
  searchCalls: Array<{ folder: string; messageId: string }>;
  appendCalls: Array<{ folder: string; raw: Buffer; flags: string[] }>;
  logoutCalls: number;
  sleeps: number[];
  lastRaw?: Buffer;
  smtpRaw?: Readable;
  appendRaw?: Readable;
}

async function readStream(raw: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of raw) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function mkDeps(opts: {
  smtpFail?: string;
  smtpRejectBeforeRead?: string;
  mailboxes: Array<{ path: string; specialUse?: string }>;
  /** For each search attempt, return true when the message is "found". */
  searchAttempts?: boolean[];
  appendFail?: string;
  appendRejectBeforeRead?: string;
  imapConnectFail?: string;
}): { deps: SendMessageDeps; rec: Recorder } {
  const rec: Recorder = {
    sendMailCalls: 0,
    smtpClosed: 0,
    imapConnected: 0,
    listCalls: 0,
    searchCalls: [],
    appendCalls: [],
    logoutCalls: 0,
    sleeps: [],
  };
  const transport: SmtpTransport = {
    async sendMail(o) {
      rec.sendMailCalls++;
      rec.smtpRaw = o.raw;
      if (opts.smtpRejectBeforeRead) throw new Error(opts.smtpRejectBeforeRead);
      rec.lastRaw = await readStream(o.raw);
      if (opts.smtpFail) throw new Error(opts.smtpFail);
    },
    close() {
      rec.smtpClosed++;
    },
  };
  let searchIdx = 0;
  const imap: ImapSentClient = {
    async connect() {
      rec.imapConnected++;
      if (opts.imapConnectFail) throw new Error(opts.imapConnectFail);
    },
    async list() {
      rec.listCalls++;
      return opts.mailboxes as unknown as Awaited<ReturnType<ImapSentClient["list"]>>;
    },
    async searchMessageId(folder, messageId) {
      rec.searchCalls.push({ folder, messageId });
      const result = opts.searchAttempts?.[searchIdx] ?? false;
      searchIdx++;
      return result;
    },
    async append(folder, raw, flags) {
      rec.appendRaw = raw;
      if (opts.appendRejectBeforeRead) throw new Error(opts.appendRejectBeforeRead);
      rec.appendCalls.push({ folder, raw: await readStream(raw), flags });
      if (opts.appendFail) throw new Error(opts.appendFail);
    },
    async logout() {
      rec.logoutCalls++;
    },
  };
  return {
    rec,
    deps: {
      createTransport: () => transport,
      createImapSentClient: () => imap,
      sleep: async (ms) => {
        rec.sleeps.push(ms);
      },
    },
  };
}

const BASE_PAYLOAD = {
  from: { name: "Me", email: "user@example.com" },
  to: [{ name: "You", email: "dest@example.com" }],
  subject: "hello",
  bodyText: "hi",
};

test("SMTP failure → no IMAP contact and ok:false", async () => {
  const { deps, rec } = mkDeps({
    smtpFail: "connection refused",
    mailboxes: [{ path: "Sent" }],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, false);
  assert.equal(rec.sendMailCalls, 1);
  assert.equal(rec.imapConnected, 0);
  assert.equal(rec.listCalls, 0);
  assert.equal(rec.searchCalls.length, 0);
  assert.equal(rec.appendCalls.length, 0);
});

test("Auto-save provider (first search hit) → no APPEND, sentCopySaved:true", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [true],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sentCopySaved, true);
  assert.equal(rec.searchCalls.length, 1);
  assert.equal(rec.appendCalls.length, 0);
  assert.equal(rec.sleeps.length, 0);
});

test("Late auto-save (2nd attempt) → no APPEND, one sleep of 500ms", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [false, true],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  assert.equal(rec.searchCalls.length, 2);
  assert.equal(rec.appendCalls.length, 0);
  assert.deepEqual(rec.sleeps, [500]);
});

test("Very late auto-save (3rd attempt) → no APPEND, two sleeps", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [false, false, true],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  assert.equal(rec.searchCalls.length, 3);
  assert.equal(rec.appendCalls.length, 0);
  assert.deepEqual(rec.sleeps, [500, 500]);
});

test("Non-auto-save provider → APPEND once with same raw MIME, same Message-ID, \\Seen", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "INBOX" }, { path: "Sent" }],
    searchAttempts: [false, false, false],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(rec.searchCalls.length, 3);
  assert.equal(rec.appendCalls.length, 1);
  assert.equal(rec.appendCalls[0].folder, "Sent");
  assert.deepEqual(rec.appendCalls[0].flags, ["\\Seen"]);
  // Same raw bytes SMTP saw:
  assert.ok(rec.lastRaw && rec.appendCalls[0].raw.equals(rec.lastRaw));
  // Same Message-ID travelled through search + returned result:
  const searched = rec.searchCalls[0].messageId;
  assert.equal(searched, r.messageId);
  // Raw MIME contains that Message-ID header:
  assert.ok(
    rec.appendCalls[0].raw.toString("utf8").toLowerCase().includes(r.messageId.toLowerCase()),
  );
});

test("APPEND failure after SMTP success → ok:true, sentCopySaved:false, no throw", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [false, false, false],
    appendFail: "quota exceeded",
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sentCopySaved, false);
  assert.equal(rec.appendCalls.length, 1);
  assert.equal(rec.logoutCalls, 1);
});

test("No Sent folder → no APPEND, ok:true, sentCopySaved:false", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "INBOX" }, { path: "Drafts" }, { path: "Trash" }],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sentCopySaved, false);
  assert.equal(rec.searchCalls.length, 0);
  assert.equal(rec.appendCalls.length, 0);
});

test("IMAP connect failure after SMTP success → still ok:true, sentCopySaved:false", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    imapConnectFail: "network unreachable",
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sentCopySaved, false);
  assert.equal(rec.sendMailCalls, 1);
  assert.equal(rec.appendCalls.length, 0);
  assert.equal(rec.logoutCalls, 1); // logout still invoked in finally
});

test("Attachments are embedded in the raw MIME that both SMTP and APPEND receive", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [false, false, false],
  });
  const r = await sendMessage(
    ACCT,
    "pw",
    {
      ...BASE_PAYLOAD,
      attachments: [
        {
          filename: "report.txt",
          content: Buffer.from("hello-attachment-body"),
          contentType: "text/plain",
        },
      ],
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.equal(rec.appendCalls.length, 1);
  const smtpMime = rec.lastRaw!.toString("utf8");
  const appendMime = rec.appendCalls[0].raw.toString("utf8");
  assert.ok(smtpMime.includes("report.txt"));
  // "hello-attachment-body" is base64-encoded inside MIME, so check the header instead:
  assert.ok(smtpMime.includes('filename="report.txt"') || smtpMime.includes("filename=report.txt"));
  assert.equal(smtpMime, appendMime, "SMTP and APPEND must see byte-identical MIME");
});

test("SPECIAL-USE \\Sent wins over well-known 'Sent' during full sendMessage", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }, { path: "Custom/Outbox", specialUse: "\\Sent" }],
    searchAttempts: [false, false, false],
  });
  const r = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(r.ok, true);
  assert.equal(rec.appendCalls[0].folder, "Custom/Outbox");
});

test("SMTP immediate rejection closes raw stream before spool cleanup", async () => {
  const { deps, rec } = mkDeps({
    smtpRejectBeforeRead: "connection rejected",
    mailboxes: [{ path: "Sent" }],
  });
  let spoolPath = "";
  deps.createMimeSpool = async (payload) => {
    const spool = await createMimeSpool(payload);
    spoolPath = spool.path;
    return spool;
  };
  const result = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(result.ok, false);
  assert.equal(rec.smtpRaw?.destroyed, true);
  await assert.rejects(access(spoolPath), /ENOENT/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("Sent APPEND immediate rejection closes raw stream and preserves SMTP success", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [false, false, false],
    appendRejectBeforeRead: "append rejected",
  });
  let spoolPath = "";
  deps.createMimeSpool = async (payload) => {
    const spool = await createMimeSpool(payload);
    spoolPath = spool.path;
    return spool;
  };
  const result = await sendMessage(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sentCopySaved, false);
  assert.equal(rec.appendRaw?.destroyed, true);
  await assert.rejects(access(spoolPath), /ENOENT/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("sendMessageFast returns after SMTP and finalizes the same spool in background", async () => {
  const { deps, rec } = mkDeps({
    mailboxes: [{ path: "Sent" }],
    searchAttempts: [false, false, false],
  });
  const jobs: Array<() => Promise<void>> = [];
  let spoolPath = "";
  deps.createMimeSpool = async (payload) => {
    const spool = await createMimeSpool(payload);
    spoolPath = spool.path;
    return spool;
  };
  deps.postSendQueue = {
    enqueue(_key, run) {
      jobs.push(run);
      return true;
    },
  };

  const result = await sendMessageFast(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(result.ok, true);
  assert.equal(rec.imapConnected, 0, "foreground must not start Sent IMAP work");
  assert.equal(jobs.length, 1);
  await access(spoolPath);

  await jobs[0]();
  assert.equal(rec.imapConnected, 1);
  assert.equal(rec.appendCalls.length, 1);
  assert.ok(rec.lastRaw && rec.appendCalls[0].raw.equals(rec.lastRaw));
  await assert.rejects(access(spoolPath), /ENOENT/);
});

test("sendMessageFast SMTP failure cleans the spool and enqueues no Sent work", async () => {
  const { deps } = mkDeps({
    smtpFail: "rejected",
    mailboxes: [{ path: "Sent" }],
  });
  let enqueueCalls = 0;
  let spoolPath = "";
  deps.createMimeSpool = async (payload) => {
    const spool = await createMimeSpool(payload);
    spoolPath = spool.path;
    return spool;
  };
  deps.postSendQueue = {
    enqueue() {
      enqueueCalls++;
      return true;
    },
  };
  const result = await sendMessageFast(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(result.ok, false);
  assert.equal(enqueueCalls, 0);
  await assert.rejects(access(spoolPath), /ENOENT/);
});

test("sendMessageFast queue saturation never resends SMTP and cleans the spool", async () => {
  const { deps, rec } = mkDeps({ mailboxes: [{ path: "Sent" }] });
  let spoolPath = "";
  deps.createMimeSpool = async (payload) => {
    const spool = await createMimeSpool(payload);
    spoolPath = spool.path;
    return spool;
  };
  deps.postSendQueue = { enqueue: () => false };
  const result = await sendMessageFast(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sentCopyPending, false);
  assert.equal(rec.sendMailCalls, 1);
  assert.equal(rec.imapConnected, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(access(spoolPath), /ENOENT/);
});

test("sendMessageFast keeps SMTP acceptance authoritative when transport close throws", async () => {
  const { deps, rec } = mkDeps({ mailboxes: [{ path: "Sent" }] });
  const createTransport = deps.createTransport;
  deps.createTransport = (account, password) => {
    const transport = createTransport(account, password);
    return {
      sendMail: (options) => transport.sendMail(options),
      close() {
        transport.close();
        throw new Error("close failed");
      },
    };
  };
  deps.postSendQueue = { enqueue: () => false };
  const result = await sendMessageFast(ACCT, "pw", BASE_PAYLOAD, deps);
  assert.equal(result.ok, true);
  assert.equal(rec.sendMailCalls, 1);
});
