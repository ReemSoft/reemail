import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { createMimeSpool } from "../src/mime-spool.js";
import { smtpRejectUnauthorized } from "../src/smtp.js";

async function consume(raw: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of raw) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("MIME spool supplies byte-identical fresh streams and cleans up", async () => {
  const spool = await createMimeSpool({
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "Recipient", email: "recipient@example.com" }],
    subject: "streamed",
    bodyText: "body",
  });

  const smtpBytes = await consume(spool.openReadStream());
  const appendBytes = await consume(spool.openReadStream());
  assert.ok(smtpBytes.length > 0);
  assert.deepEqual(appendBytes, smtpBytes);
  assert.match(smtpBytes.toString("utf8"), new RegExp(spool.messageId.replace(/[<>]/g, "")));

  await spool.cleanup();
  await assert.rejects(access(spool.path));
  await spool.cleanup();
});

test("SMTP verifies certificates unless the emergency switch is explicit", () => {
  assert.equal(smtpRejectUnauthorized({} as NodeJS.ProcessEnv), true);
  assert.equal(smtpRejectUnauthorized({ MAIL_ALLOW_INSECURE_TLS: "false" }), true);
  assert.equal(smtpRejectUnauthorized({ MAIL_ALLOW_INSECURE_TLS: "true" }), false);
});
