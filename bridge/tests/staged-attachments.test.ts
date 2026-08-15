import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const productionDefaultStageDir = path.resolve("/tmp/mailmaestro-stage");
const inheritedStageDir = process.env.MAIL_STAGE_DIR;
const configuredProductionStageDir = path.resolve(inheritedStageDir || "/tmp/mailmaestro-stage");
const testStageDir = await mkdtemp(path.join(tmpdir(), "mailmaestro-stage-test-"));
assert.notEqual(path.resolve(testStageDir), productionDefaultStageDir);
assert.notEqual(path.resolve(testStageDir), configuredProductionStageDir);
process.env.MAIL_STAGE_DIR = testStageDir;

const {
  STAGE_DIR,
  cleanupSendStagedAttachments,
  cleanupStagedAttachments,
  releaseStagedAttachment,
  resolveStagedAttachment,
  stageAttachmentStream,
  stagedAttachmentStats,
} = await import("../src/staged-attachments.js");

assert.equal(path.resolve(STAGE_DIR), path.resolve(testStageDir));
assert.notEqual(path.resolve(STAGE_DIR), productionDefaultStageDir);
assert.notEqual(path.resolve(STAGE_DIR), configuredProductionStageDir);
assert.deepEqual(stagedAttachmentStats(), {
  stagedBytes: 0,
  stagedFiles: 0,
  trackedAccounts: 0,
});

after(async () => {
  assert.equal(path.resolve(STAGE_DIR), path.resolve(testStageDir));
  assert.notEqual(path.resolve(STAGE_DIR), productionDefaultStageDir);
  assert.notEqual(path.resolve(STAGE_DIR), configuredProductionStageDir);
  await rm(testStageDir, { recursive: true, force: true });
  if (inheritedStageDir === undefined) delete process.env.MAIL_STAGE_DIR;
  else process.env.MAIL_STAGE_DIR = inheritedStageDir;
});

const secret = "stage-test-secret";
const account = "a".repeat(64);

function assertInsideTestStageDir(filePath: string) {
  const root = `${path.resolve(testStageDir)}${path.sep}`;
  assert.ok(path.resolve(filePath).startsWith(root));
}

test("test staging is unique and production default remains unchanged", async () => {
  assert.notEqual(path.resolve(STAGE_DIR), productionDefaultStageDir);
  assert.notEqual(path.resolve(STAGE_DIR), configuredProductionStageDir);
  assert.match(path.basename(STAGE_DIR), /^mailmaestro-stage-test-/);
  assert.deepEqual(await readdir(STAGE_DIR), []);
  const source = readFileSync(new URL("../src/staged-attachments.ts", import.meta.url), "utf8");
  assert.match(source, /: "\/tmp\/mailmaestro-stage"/);
});

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
  assertInsideTestStageDir(resolved.path);
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

test("decoded-stream limiter rejects bytes above maxSize (authoritative size check)", async () => {
  // An encoded server-source attachment is always larger than its decoded
  // bytes, so the limit must be enforced on the DECODED stream, not on any
  // encoded metadata. Streaming 64 decoded bytes with a 10-byte cap must
  // fail with UPLOAD_TOO_LARGE.
  await assert.rejects(
    stageAttachmentStream({
      secret,
      account,
      filename: "over.bin",
      mimeType: "application/octet-stream",
      kind: "attachment",
      declaredSize: 64,
      maxSize: 10,
      exactSize: false,
      stream: Readable.from(Buffer.alloc(64, 0x62)),
    }),
    /UPLOAD_TOO_LARGE/,
  );
});

test("decoded stream at exactly maxSize is allowed (limit is strictly greater)", async () => {
  const staged = await stageAttachmentStream({
    secret,
    account,
    filename: "at-limit.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 10,
    maxSize: 10,
    exactSize: false,
    stream: Readable.from(Buffer.alloc(10, 0x63)),
  });
  assert.equal(staged.size, 10);
  await releaseStagedAttachment(secret, staged.handle, account);
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
  assert.deepEqual(stagedAttachmentStats(), {
    stagedBytes: 0,
    stagedFiles: 0,
    trackedAccounts: 0,
  });
  const normal = await stageTestFile("normal.bin", "normal");
  const inline = await stageTestFile("inline.png", "inline", "inline-image");
  const source = await stageTestFile("source.bin", "source");
  const stagedBytes = normal.size + inline.size + source.size;
  assert.deepEqual(stagedAttachmentStats(), {
    stagedBytes,
    stagedFiles: 3,
    trackedAccounts: 1,
  });
  for (const staged of [normal, inline, source]) {
    const resolved = await resolveStagedAttachment(secret, staged.handle, account);
    assertInsideTestStageDir(resolved.path);
  }

  await cleanupSendStagedAttachments({
    secret,
    account,
    clientHandles: [normal.handle, inline.handle, normal.handle],
    sourceHandles: [source.handle, source.handle],
    sendSucceeded: true,
  });

  assert.deepEqual(stagedAttachmentStats(), {
    stagedBytes: 0,
    stagedFiles: 0,
    trackedAccounts: 0,
  });
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
  assert.deepEqual(stagedAttachmentStats(), {
    stagedBytes: 0,
    stagedFiles: 0,
    trackedAccounts: 0,
  });
  const staged = await stageTestFile("once.bin", "once");
  assert.equal(stagedAttachmentStats().stagedBytes, staged.size);
  assert.equal(stagedAttachmentStats().stagedFiles, 1);
  assert.equal(await releaseStagedAttachment(secret, staged.handle, account), true);
  assert.equal(await releaseStagedAttachment(secret, staged.handle, account), false);
  assert.deepEqual(stagedAttachmentStats(), {
    stagedBytes: 0,
    stagedFiles: 0,
    trackedAccounts: 0,
  });
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
