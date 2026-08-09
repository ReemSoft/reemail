import assert from "node:assert/strict";
import { access, unlink } from "node:fs/promises";
import test from "node:test";
import { createMimeSpool, withMimeSpoolReadStream } from "../src/mime-spool.js";
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

test("owned MIME stream is settled before cleanup after an early consumer failure", async () => {
  const spool = await createMimeSpool({
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "Recipient", email: "recipient@example.com" }],
    subject: "early failure",
    bodyText: "body",
  });
  let raw: import("node:stream").Readable | null = null;
  await assert.rejects(
    withMimeSpoolReadStream(spool, async (input) => {
      raw = input;
      throw new Error("consumer rejected");
    }),
    /consumer rejected/,
  );
  assert.equal(raw?.destroyed, true);
  await spool.cleanup();
  await assert.rejects(access(spool.path), /ENOENT/);
});

test("MIME read-stream errors fail the consumer without escaping asynchronously", async () => {
  const spool = await createMimeSpool({
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "Recipient", email: "recipient@example.com" }],
    subject: "stream error",
    bodyText: "body",
  });
  await unlink(spool.path);
  let raw: import("node:stream").Readable | null = null;
  await assert.rejects(
    withMimeSpoolReadStream(spool, async (input) => {
      raw = input;
      await consume(input);
    }),
    /ENOENT/,
  );
  assert.equal(raw?.destroyed, true);
  await spool.cleanup();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
