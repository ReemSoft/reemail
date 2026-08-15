/**
 * Atomic staged-quota accounting — byte budgets (A).
 *
 * The byte limits share the same reservation mechanism as the file-count
 * limits (reserved bytes are counted against quota before streaming starts).
 * These tests lock the account and global byte budgets under concurrency.
 *
 * Env chosen so each budget binds independently:
 *   ACCOUNT_BYTES=500, GLOBAL_BYTES=600.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const testStageDir = await mkdtemp(path.join(tmpdir(), "mailmaestro-stage-bytes-"));
process.env.MAIL_STAGE_DIR = testStageDir;
process.env.MAIL_STAGE_ACCOUNT_FILES = "100";
process.env.MAIL_STAGE_ACCOUNT_BYTES = "500";
process.env.MAIL_STAGE_GLOBAL_FILES = "100";
process.env.MAIL_STAGE_GLOBAL_BYTES = "600";

const {
  cleanupStagedAttachments,
  releaseStagedAttachment,
  stageAttachmentStream,
  stagedAttachmentStats,
} = await import("../src/staged-attachments.js");

const secret = "accounting-bytes-secret";
const account = "e".repeat(64);
const account2 = "f".repeat(64);

after(async () => {
  await rm(testStageDir, { recursive: true, force: true });
  for (const key of [
    "MAIL_STAGE_DIR",
    "MAIL_STAGE_ACCOUNT_FILES",
    "MAIL_STAGE_ACCOUNT_BYTES",
    "MAIL_STAGE_GLOBAL_FILES",
    "MAIL_STAGE_GLOBAL_BYTES",
  ]) {
    delete process.env[key];
  }
});

function stageBytes(bytes: number, name: string, opts: { account?: string } = {}) {
  return stageAttachmentStream({
    secret,
    account: opts.account ?? account,
    filename: `${name}.bin`,
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: bytes,
    stream: Readable.from(Buffer.alloc(bytes, 0x61)),
  });
}

test("account byte budget is reserved so concurrent uploads cannot overshoot", async () => {
  await cleanupStagedAttachments();
  const results = await Promise.allSettled([
    stageBytes(300, "ab1"),
    stageBytes(300, "ab2"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1); // 300 <= 500, second would be 600 > 500
  assert.equal(rejected.length, 1);
  assert.match((rejected[0] as PromiseRejectedResult).reason?.message ?? "", /STAGE_QUOTA_EXCEEDED/);
  assert.equal(stagedAttachmentStats().stagedBytes, 300);
  for (const r of ok) {
    await releaseStagedAttachment(secret, r.value.handle, account);
  }
  assert.equal(stagedAttachmentStats().stagedBytes, 0);
});

test("global byte budget is reserved across concurrent uploads", async () => {
  await cleanupStagedAttachments();
  const results = await Promise.allSettled([
    stageBytes(400, "gb1"),
    stageBytes(400, "gb2"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1); // 400 <= 600, second would be 800 > 600
  assert.equal(rejected.length, 1);
  assert.match((rejected[0] as PromiseRejectedResult).reason?.message ?? "", /STAGE_QUOTA_EXCEEDED/);
  assert.equal(stagedAttachmentStats().stagedBytes, 400);
  for (const r of ok) {
    await releaseStagedAttachment(secret, r.value.handle, account);
  }
  assert.equal(stagedAttachmentStats().stagedBytes, 0);
});

test("sequential staging respects account and global byte budgets", async () => {
  await cleanupStagedAttachments();
  const a = await stageBytes(300, "seq-account");
  assert.equal(stagedAttachmentStats().stagedBytes, 300);
  const b = await stageBytes(200, "seq-account2", { account: account2 });
  assert.equal(stagedAttachmentStats().stagedBytes, 500); // 500 <= 600 global
  await assert.rejects(stageBytes(200, "seq-account3"), /STAGE_QUOTA_EXCEEDED/);
  await releaseStagedAttachment(secret, a.handle, account);
  await releaseStagedAttachment(secret, b.handle, account2);
  assert.equal(stagedAttachmentStats().stagedBytes, 0);
});