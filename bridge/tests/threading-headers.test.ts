import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import { draftMimePayload } from "../src/drafts.js";
import { parsedMailToMessage } from "../src/imap.js";
import { compileMime } from "../src/mime-spool.js";
import type { SendMessagePayload } from "../src/smtp.js";
import { MAX_THREAD_REFERENCES, normalizeThreadingHeaders } from "../src/threading-headers.js";

async function parseMime(payload: SendMessagePayload) {
  const compiled = compileMime(payload);
  const raw = await new Promise<Buffer>((resolve, reject) => {
    compiled.build((error: Error | null, value: Buffer) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  return simpleParser(raw);
}

function payload(overrides: Partial<SendMessagePayload> = {}): SendMessagePayload {
  return {
    from: { name: "Me", email: "me@example.com" },
    to: [{ name: "Support", email: "support@example.com" }],
    subject: "Reply",
    bodyText: "Body",
    ...overrides,
  };
}

test("same already-fetched message headers expose Reply-To without another IMAP operation", async () => {
  const parsed = await simpleParser(
    Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "Reply-To: الدعم <support@example.com>, Team <team@example.com>",
        "To: Me <me@example.com>",
        "Message-ID: <m3@example.com>",
        "References: <m1@example.com> <m2@example.com>",
        "Subject: Reply-To fixture",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body",
      ].join("\r\n"),
    ),
  );
  const message = parsedMailToMessage(parsed, "inbox");
  assert.deepEqual(message.replyTo, [
    { name: "الدعم", email: "support@example.com" },
    { name: "Team", email: "team@example.com" },
  ]);
  assert.equal(message.threadId, "<m3@example.com>");
  assert.deepEqual(message.references, ["<m1@example.com>", "<m2@example.com>"]);
});

test("normal Reply produces exact Reply-To target and RFC threading MIME headers", async () => {
  const parsed = await parseMime(
    payload({
      inReplyTo: "<m3@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
    }),
  );
  assert.deepEqual(
    parsed.to?.value.map((item) => item.address),
    ["support@example.com"],
  );
  assert.equal(parsed.inReplyTo, "<m3@example.com>");
  assert.equal(parsed.references?.join(" "), "<m1@example.com> <m2@example.com> <m3@example.com>");
  assert.match(parsed.messageId ?? "", /^<.+@.+>$/);
});

test("Reply All preserves To/Cc distinctions without duplicate recipients", async () => {
  const parsed = await parseMime(
    payload({
      to: [
        { name: "Support", email: "support@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
      cc: [{ name: "Carol", email: "carol@example.com" }],
      inReplyTo: "<m3@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
    }),
  );
  assert.deepEqual(
    parsed.to?.value.map((item) => item.address),
    ["support@example.com", "bob@example.com"],
  );
  assert.deepEqual(
    parsed.cc?.value.map((item) => item.address),
    ["carol@example.com"],
  );
  assert.equal(parsed.inReplyTo, "<m3@example.com>");
});

test("new compose and Forward stay free of reply threading headers", async () => {
  for (const subject of ["New", "Fwd: Subject"]) {
    const parsed = await parseMime(payload({ subject }));
    assert.equal(parsed.inReplyTo, undefined);
    assert.equal(parsed.references, undefined);
  }
});

test("invalid or injectable parent metadata fails closed at the MIME boundary", async () => {
  for (const inReplyTo of ["inbox:55", "folder:123", "<ok@example.com>\r\nBcc: bad@example.com"]) {
    const parsed = await parseMime(
      payload({ inReplyTo, references: ["<ancestor@example.com>", "bad\r\nX-Evil: yes"] }),
    );
    assert.equal(parsed.inReplyTo, undefined);
    assert.equal(parsed.references, undefined);
  }
});

test("MIME boundary normalizes, deduplicates, orders, and bounds References", () => {
  const references = Array.from({ length: 130 }, (_, index) => `<m${index}@example.com>`);
  references.splice(1, 0, "m0@example.com", "folder:2");
  const result = normalizeThreadingHeaders("parent@example.com", references);
  assert.equal(result.inReplyTo, "<parent@example.com>");
  assert.equal(result.references?.length, MAX_THREAD_REFERENCES);
  assert.equal(result.references?.[0], "<m0@example.com>");
  assert.equal(result.references?.at(-1), "<parent@example.com>");
});

test("remote draft MIME retains threading metadata through the production draft mapper", async () => {
  const draft = draftMimePayload({
    account: {
      email_address: "me@example.com",
      display_name: "Me",
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_secure: true,
      smtp_host: "smtp.example.com",
      smtp_port: 465,
      smtp_secure: true,
    },
    password: "secret",
    draftId: "00000000-0000-4000-8000-000000000001",
    to: [{ name: "Support", email: "support@example.com" }],
    cc: [],
    bcc: [],
    subject: "Reply draft",
    bodyText: "Body",
    inReplyTo: "<m3@example.com>",
    references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
    inlineImages: [],
  });
  const parsed = await parseMime(draft);
  assert.equal(parsed.inReplyTo, "<m3@example.com>");
  assert.equal(parsed.references?.join(" "), "<m1@example.com> <m2@example.com> <m3@example.com>");
});
