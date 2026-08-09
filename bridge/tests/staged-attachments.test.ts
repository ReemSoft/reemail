import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import {
  cleanupSendStagedAttachments,
  cleanupStagedAttachments,
  releaseStagedAttachment,
  resolveStagedAttachment,
  stageAttachmentStream,
  stagedAttachmentStats,
} from "../src/staged-attachments.js";

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
  assert.equal(await releaseStagedAttachment(secret, staged.handle, account), true);
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
  await cleanupStagedAttachments();
  await assert.rejects(
    resolveStagedAttachment(secret, `${staged.handle}x`, account, 2),
    /INVALID_TICKET/,
  );
});

async function stageTestFile(
  filename: string,
  body: string,
  kind: "attachment" | "inline-image" = "attachment",
) {
  return stageAttachmentStream({
    secret,
    account,
    filename,
    mimeType: kind === "inline-image" ? "image/png" : "application/octet-stream",
    kind,
    declaredSize: Buffer.byteLength(body),
    stream: Readable.from(Buffer.from(body)),
  });
}

test("successful send releases normal, inline, and temporary source handles", async () => {
  const before = stagedAttachmentStats();
  const normal = await stageTestFile("normal.bin", "normal");
  const inline = await stageTestFile("inline.png", "inline", "inline-image");
  const source = await stageTestFile("source.bin", "source");
  const stagedBytes = normal.size + inline.size + source.size;
  assert.deepEqual(stagedAttachmentStats(), {
    stagedBytes: before.stagedBytes + stagedBytes,
    stagedFiles: before.stagedFiles + 3,
    trackedAccounts: before.trackedAccounts + (before.trackedAccounts === 0 ? 1 : 0),
  });

  await cleanupSendStagedAttachments({
    secret,
    account,
    clientHandles: [normal.handle, inline.handle, normal.handle],
    sourceHandles: [source.handle, source.handle],
    sendSucceeded: true,
  });

  assert.equal(stagedAttachmentStats().stagedBytes, before.stagedBytes);
  assert.equal(stagedAttachmentStats().stagedFiles, before.stagedFiles);
  await assert.rejects(
    resolveStagedAttachment(secret, normal.handle, account),
    /STAGED_FILE_MISSING/,
  );
  await assert.rejects(
    resolveStagedAttachment(secret, inline.handle, account),
    /STAGED_FILE_MISSING/,
  );
  await assert.rejects(
    resolveStagedAttachment(secret, source.handle, account),
    /STAGED_FILE_MISSING/,
  );
});

test("failed send retains client handles but always releases temporary source handles", async () => {
  const client = await stageTestFile("retry.bin", "retry");
  const source = await stageTestFile("temporary.bin", "temporary");
  await cleanupSendStagedAttachments({
    secret,
    account,
    clientHandles: [client.handle],
    sourceHandles: [source.handle],
    sendSucceeded: false,
  });
  assert.equal((await resolveStagedAttachment(secret, client.handle, account)).size, client.size);
  await assert.rejects(
    resolveStagedAttachment(secret, source.handle, account),
    /STAGED_FILE_MISSING/,
  );
  await releaseStagedAttachment(secret, client.handle, account);
});

test("release is idempotent and quota counters never become negative", async () => {
  const before = stagedAttachmentStats();
  const staged = await stageTestFile("once.bin", "once");
  assert.equal(stagedAttachmentStats().stagedBytes, before.stagedBytes + staged.size);
  assert.equal(stagedAttachmentStats().stagedFiles, before.stagedFiles + 1);
  assert.equal(await releaseStagedAttachment(secret, staged.handle, account), true);
  assert.equal(await releaseStagedAttachment(secret, staged.handle, account), false);
  assert.equal(stagedAttachmentStats().stagedBytes, before.stagedBytes);
  assert.equal(stagedAttachmentStats().stagedFiles, before.stagedFiles);
  assert.ok(stagedAttachmentStats().stagedBytes >= 0);
  assert.ok(stagedAttachmentStats().stagedFiles >= 0);
});

test("local staging throughput benchmark streams 1/4/10/25 MiB with bounded chunks", async () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (const mib of [1, 4, 10, 25]) {
    const bytes = mib * 1024 * 1024;
    async function* generated() {
      let remaining = bytes;
      while (remaining > 0) {
        const length = Math.min(remaining, chunk.length);
        yield length === chunk.length ? chunk : chunk.subarray(0, length);
        remaining -= length;
      }
    }
    const startedAt = performance.now();
    const staged = await stageAttachmentStream({
      secret,
      account,
      filename: `benchmark-${mib}.bin`,
      mimeType: "application/octet-stream",
      kind: "attachment",
      declaredSize: bytes,
      stream: Readable.from(generated()),
    });
    const elapsedMs = performance.now() - startedAt;
    console.log(`[staging-benchmark] mib=${mib} ms=${elapsedMs.toFixed(1)}`);
    assert.equal(staged.size, bytes);
    await releaseStagedAttachment(secret, staged.handle, account);
  }
});
