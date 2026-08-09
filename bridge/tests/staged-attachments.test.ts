import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { resolveStagedAttachment, stageAttachmentStream } from "../src/staged-attachments.js";

const secret = "stage-test-secret";
const account = "a".repeat(64);

test("staged attachment round-trips metadata without exposing a path", async () => {
  const staged = await stageAttachmentStream({
    secret,
    account,
    filename: "report.pdf",
    mimeType: "application/pdf",
    kind: "attachment",
    declaredSize: 4,
    stream: Readable.from(Buffer.from("test")),
  });
  assert.equal("path" in staged, false);
  const resolved = await resolveStagedAttachment(secret, staged.handle, account);
  assert.equal(resolved.size, 4);
  assert.equal(resolved.filename, "report.pdf");
  await unlink(resolved.path);
});

test("staging removes declared-size mismatches", async () => {
  await assert.rejects(
    stageAttachmentStream({
      secret,
      account,
      filename: "bad.bin",
      mimeType: "application/octet-stream",
      kind: "attachment",
      declaredSize: 5,
      stream: Readable.from(Buffer.from("tiny")),
    }),
    /UPLOAD_SIZE_MISMATCH/,
  );
});

test("staged handle rejects wrong account, expiry, missing file, and tampering", async () => {
  const staged = await stageAttachmentStream({
    secret,
    account,
    filename: "one.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 1,
    stream: Readable.from(Buffer.from("x")),
    now: 1,
  });
  await assert.rejects(
    resolveStagedAttachment(secret, staged.handle, "b".repeat(64), 2),
    /TICKET_ACCOUNT_MISMATCH/,
  );
  await assert.rejects(
    resolveStagedAttachment(secret, staged.handle, account, staged.expiresAt),
    /EXPIRED_TICKET/,
  );
  const resolved = await resolveStagedAttachment(secret, staged.handle, account, 2);
  await unlink(resolved.path);
  await assert.rejects(
    resolveStagedAttachment(secret, staged.handle, account, 2),
    /STAGED_FILE_MISSING/,
  );
  await assert.rejects(
    resolveStagedAttachment(secret, `${staged.handle}x`, account, 2),
    /INVALID_TICKET/,
  );
});
