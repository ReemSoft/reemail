import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadEmlSourceInMailbox,
  EmlDownloadTooLargeError,
} from "../src/eml-download.js";

test("downloads byte-identical RFC822 source after UIDVALIDITY verification", async () => {
  const raw = Buffer.from(
    "From: a@example.com\r\nTo: b@example.com\r\nSubject: Test\r\n\r\nHello\r\n",
    "utf8",
  );
  const calls: string[] = [];

  const client = {
    mailbox: { uidValidity: "77" },
    async fetchOne(_uid: string, query: Record<string, unknown>) {
      if (query.size) {
        calls.push("size");
        return { uid: 42, size: raw.length };
      }
      if (query.source) {
        calls.push("source");
        return { uid: 42, source: raw };
      }
      return false;
    },
  };

  const result = await downloadEmlSourceInMailbox(
    client as never,
    42,
    "77",
  );

  assert.deepEqual(result, raw);
  assert.deepEqual(calls, ["size", "source"]);
});

test("UIDVALIDITY mismatch performs zero source I/O", async () => {
  let calls = 0;

  const client = {
    mailbox: { uidValidity: "88" },
    async fetchOne() {
      calls += 1;
      return false;
    },
  };

  await assert.rejects(
    () => downloadEmlSourceInMailbox(client as never, 42, "77"),
    /UIDVALIDITY_MISMATCH/,
  );

  assert.equal(calls, 0);
});

test("declared oversize rejects before RFC822 source transfer", async () => {
  let sourceCalls = 0;

  const client = {
    mailbox: { uidValidity: "77" },
    async fetchOne(_uid: string, query: Record<string, unknown>) {
      if (query.size) return { uid: 42, size: 101 };
      sourceCalls += 1;
      return { uid: 42, source: Buffer.alloc(101) };
    },
  };

  await assert.rejects(
    () => downloadEmlSourceInMailbox(client as never, 42, "77", 100),
    EmlDownloadTooLargeError,
  );

  assert.equal(sourceCalls, 0);
});

test("actual source overflow fails closed even if declared size was smaller", async () => {
  const client = {
    mailbox: { uidValidity: "77" },
    async fetchOne(_uid: string, query: Record<string, unknown>) {
      if (query.size) return { uid: 42, size: 90 };
      return { uid: 42, source: Buffer.alloc(101) };
    },
  };

  await assert.rejects(
    () => downloadEmlSourceInMailbox(client as never, 42, "77", 100),
    EmlDownloadTooLargeError,
  );
});

test("truncated RFC822 source is never served as a valid EML", async () => {
  const client = {
    mailbox: { uidValidity: "77" },
    async fetchOne(_uid: string, query: Record<string, unknown>) {
      if (query.size) return { uid: 42, size: 100 };
      return { uid: 42, source: Buffer.alloc(90) };
    },
  };

  await assert.rejects(
    () => downloadEmlSourceInMailbox(client as never, 42, "77", 200),
    /EML_SOURCE_INCOMPLETE/,
  );
});
