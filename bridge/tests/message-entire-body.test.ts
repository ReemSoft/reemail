import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { ImapFlow } from "imapflow";
import {
  downloadEntireBodyInMailbox,
  MESSAGE_BODY_MAX_BYTES,
  MESSAGE_ENTIRE_BODY_MAX_BYTES,
  MessageBodyTooLargeError,
  pickTextPart,
} from "../src/imap.js";
import type { MailAccount } from "../src/types.js";

const account: MailAccount = {
  email_address: "user@example.com",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_secure: true,
};

function mockClient(body: Buffer, structure: object) {
  const downloads: { uid: string; part: string; options: object }[] = [];
  const client = {
    mailbox: { uidValidity: 77n },
    async fetchOne(_uid: string, query: object, options: object) {
      assert.deepEqual(query, { uid: true, bodyStructure: true });
      assert.deepEqual(options, { uid: true });
      return { uid: 9, bodyStructure: structure };
    },
    async download(uid: string, part: string, options: object) {
      downloads.push({ uid, part, options });
      return { content: Readable.from([body]), meta: { contentType: "text/html; charset=utf-8" } };
    },
  };
  return { client: client as unknown as ImapFlow, downloads };
}

test("initial and explicit body limits remain separate", () => {
  assert.equal(MESSAGE_BODY_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(MESSAGE_ENTIRE_BODY_MAX_BYTES, 16 * 1024 * 1024);
});

test("explicit operation returns a complete body larger than five MiB with one selected download", async () => {
  const html = Buffer.from(`<p>${"x".repeat(5 * 1024 * 1024)}</p>`);
  const { client, downloads } = mockClient(html, {
    type: "multipart/mixed",
    childNodes: [
      { type: "text/html", part: "1" },
      { type: "application/pdf", part: "2", disposition: "attachment", size: 1234 },
    ],
  });

  const result = await downloadEntireBodyInMailbox(client, account, 9, "inbox");
  assert.equal(result?.body.length, html.length);
  assert.equal(result?.bodyTruncated, false);
  assert.equal(result?.uidValidity, "77");
  assert.deepEqual(downloads, [
    {
      uid: "9",
      part: "1",
      options: { uid: true, maxBytes: MESSAGE_ENTIRE_BODY_MAX_BYTES },
    },
  ]);
});

test("explicit operation returns later CID metadata without downloading CID or attachment bytes", async () => {
  const html = Buffer.from('<p>prefix</p><img src="cid:late-logo">');
  const { client, downloads } = mockClient(html, {
    type: "multipart/related",
    childNodes: [
      { type: "text/html", part: "1" },
      {
        type: "image/png",
        part: "2",
        disposition: "inline",
        dispositionParameters: { filename: "logo.png" },
        id: "<late-logo>",
        size: 120,
      },
      { type: "application/pdf", part: "3", disposition: "attachment", size: 400 },
    ],
  });

  const result = await downloadEntireBodyInMailbox(client, account, 9, "inbox");
  assert.deepEqual(result?.inlineParts, [
    { cid: "late-logo", part: "2", mimeType: "image/png", size: 120 },
  ]);
  assert.deepEqual(
    downloads.map((item) => item.part),
    ["1"],
  );
});

test("safety-ceiling hit fails closed and is never returned as complete", async () => {
  const { client } = mockClient(Buffer.alloc(MESSAGE_ENTIRE_BODY_MAX_BYTES, 120), {
    type: "text/html",
    part: "1",
  });
  await assert.rejects(
    downloadEntireBodyInMailbox(client, account, 9, "inbox"),
    MessageBodyTooLargeError,
  );
});

test("explicit and initial operations share the MIME picker and message/rfc822 boundary", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { type: "message/rfc822", part: "1", childNodes: [{ type: "text/html", part: "1.1" }] },
      { type: "text/plain", part: "2" },
    ],
  };
  assert.deepEqual(pickTextPart(structure), {
    part: "2",
    type: "text/plain",
    charset: undefined,
  });
});

test("dedicated endpoint is protected, interactive-gated, validates input and maps the ceiling", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const route = source.slice(
    source.indexOf('app.post("/api/message-entire"'),
    source.indexOf('app.post("/api/message-inline-images"'),
  );
  assert.match(route, /requireKey, imapGate\("interactive"\)/);
  assert.match(route, /EntireMessagePayloadSchema\.parse\(req\.body\)/);
  assert.match(route, /status\(400\).*INVALID_PAYLOAD/s);
  assert.match(route, /status\(413\).*err\.code/s);
});
