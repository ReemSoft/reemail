// Regression guard for the ImapFlow 1.5 APPEND contract.
//
// ImapFlow's `append(path, content, ...)` accepts `string | Buffer` ONLY.
// Passing a Readable made `content.length` / `content.indexOf` undefined and
// surfaced in production as an opaque IMAP_UNKNOWN Sent-copy failure.
//
// These tests lock the contract permanently:
//   * every APPEND attempt receives a Buffer (the fake rejects anything else)
//   * a retry re-reads the same spool and is byte-identical
//   * SMTP keeps receiving a streaming Readable (never a Buffer)
//   * Message-ID is unchanged, max 2 APPEND attempts, spool cleaned exactly once
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createMimeSpool, readMimeSpoolBuffer, MimeSpoolTooLargeError } from "../src/mime-spool.js";
import {
  sendMessageFast,
  type ImapSentClient,
  type SendMessageDeps,
  type SmtpTransport,
} from "../src/smtp.js";
import type { MailAccount } from "../src/types.js";

const ACCT = {
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

const PAYLOAD = {
  from: { name: "Me", email: "user@example.com" },
  to: [{ name: "You", email: "dest@example.com" }],
  subject: "buffer contract",
  bodyText: "hi",
};

interface Rec {
  appendBuffers: Buffer[];
  smtpRawIsStream: boolean[];
  smtpRawIsBuffer: boolean[];
  cleanups: number;
  messageIds: string[];
}

function mkDeps(opts: { appendFailFirst?: boolean }): {
  deps: SendMessageDeps;
  rec: Rec;
  runJobs: () => Promise<void>;
} {
  const rec: Rec = {
    appendBuffers: [],
    smtpRawIsStream: [],
    smtpRawIsBuffer: [],
    cleanups: 0,
    messageIds: [],
  };
  const transport: SmtpTransport = {
    async sendMail(o) {
      rec.smtpRawIsStream.push(o.raw instanceof Readable);
      rec.smtpRawIsBuffer.push(Buffer.isBuffer(o.raw));
      for await (const _chunk of o.raw) {
        void _chunk;
      }
    },
    close() {},
  };
  let appendCount = 0;
  const imap: ImapSentClient = {
    async connect() {},
    async list() {
      return [{ path: "Sent" }] as unknown as Awaited<ReturnType<ImapSentClient["list"]>>;
    },
    async searchMessageId() {
      return false;
    },
    async append(_folder, raw, _flags) {
      // Hard contract: anything that is not a Buffer is a bug.
      if (!Buffer.isBuffer(raw)) {
        throw new Error(`IMAP append expects a Buffer, received ${typeof raw}`);
      }
      appendCount++;
      rec.appendBuffers.push(Buffer.from(raw));
      if (opts.appendFailFirst && appendCount === 1) {
        const error = new Error("socket closed") as Error & { code: string };
        error.code = "ECONNECTIONCLOSED";
        throw error;
      }
      return {};
    },
    async logout() {},
  };
  const jobs: Array<() => Promise<unknown>> = [];
  return {
    rec,
    deps: {
      createTransport: () => transport,
      createImapSentClient: () => imap,
      sleep: async () => {},
      createMimeSpool: async (payload) => {
        const spool = await createMimeSpool(payload);
        rec.messageIds.push(spool.messageId);
        const cleanup = spool.cleanup;
        return {
          ...spool,
          cleanup: async () => {
            rec.cleanups++;
            await cleanup();
          },
        };
      },
      postSendQueue: {
        enqueueTracked: (_key, run) => {
          jobs.push(run);
          return { accepted: true, jobId: "job-1", state: "pending" };
        },
      },
    },
    runJobs: async () => {
      for (const job of jobs.splice(0)) await job();
    },
  };
}

test("Sent APPEND receives a Buffer while SMTP still receives a Readable stream", async () => {
  const { deps, rec, runJobs } = mkDeps({});
  const result = await sendMessageFast(ACCT, "pw", PAYLOAD, deps);
  assert.equal(result.ok, true);
  await runJobs();

  assert.equal(rec.smtpRawIsStream[0], true, "SMTP foreground must stay streaming");
  assert.equal(rec.smtpRawIsBuffer[0], false);
  assert.equal(rec.appendBuffers.length, 1);
  assert.equal(Buffer.isBuffer(rec.appendBuffers[0]), true);
  assert.ok(rec.appendBuffers[0].length > 0);
  assert.equal(rec.cleanups, 1, "spool cleanup exactly once");
});

test("APPEND retry re-reads the same spool: byte-identical Buffer, same Message-ID, max 2 attempts", async () => {
  const { deps, rec, runJobs } = mkDeps({ appendFailFirst: true });
  const result = await sendMessageFast(ACCT, "pw", PAYLOAD, deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await runJobs();

  assert.equal(rec.appendBuffers.length, 2, "no third APPEND attempt");
  assert.equal(Buffer.isBuffer(rec.appendBuffers[0]), true);
  assert.equal(Buffer.isBuffer(rec.appendBuffers[1]), true);
  assert.equal(rec.appendBuffers[0].equals(rec.appendBuffers[1]), true);
  assert.equal(rec.messageIds.length, 1);
  assert.equal(result.messageId, rec.messageIds[0], "Message-ID unchanged across retry");
  assert.equal(rec.cleanups, 1, "spool cleanup exactly once");
});

test("readMimeSpoolBuffer returns the exact on-disk bytes and enforces a bounded ceiling", async () => {
  const spool = await createMimeSpool(PAYLOAD);
  try {
    const buffer = await readMimeSpoolBuffer(spool);
    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer.byteLength, spool.size);
    await assert.rejects(() => readMimeSpoolBuffer(spool, 1), MimeSpoolTooLargeError);
  } finally {
    await spool.cleanup();
  }
});
