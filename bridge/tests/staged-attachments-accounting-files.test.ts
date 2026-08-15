/**
 * Atomic staged-quota accounting — file-count limits (A).
 *
 * These tests exercise the reservation mechanism added to
 * bridge/src/staged-attachments.ts: quota checks must include in-flight
 * reservations so concurrent uploads cannot overshoot the account/global file
 * caps, cleanup must never double-count an in-flight upload, and counters must
 * always match the files actually present on disk.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const testStageDir = await mkdtemp(path.join(tmpdir(), "mailmaestro-stage-files-"));
process.env.MAIL_STAGE_DIR = testStageDir;
process.env.MAIL_STAGE_ACCOUNT_FILES = "3";
process.env.MAIL_STAGE_ACCOUNT_BYTES = String(1024 ** 3);
process.env.MAIL_STAGE_GLOBAL_FILES = "5";
process.env.MAIL_STAGE_GLOBAL_BYTES = String(1024 ** 3);

const {
  STAGE_DIR,
  cleanupStagedAttachments,
  releaseStagedAttachment,
  resolveStagedAttachment,
  stageAttachmentStream,
  stagedAttachmentStats,
} = await import("../src/staged-attachments.js");

const secret = "accounting-files-secret";
const account = "c".repeat(64);
const account2 = "d".repeat(64);

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

function stage(body: string, opts: { account?: string } = {}) {
  return stageAttachmentStream({
    secret,
    account: opts.account ?? account,
    filename: `${body}.bin`,
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: Buffer.byteLength(body),
    stream: Readable.from(Buffer.from(body)),
  });
}

async function diskFiles(): Promise<string[]> {
  return (await readdir(STAGE_DIR)).filter((name) => name.endsWith(".bin"));
}

// A clean slate independent of TTL: drop every staged file on disk, then
// reconcile the counters with the (now empty) directory.
async function resetStage() {
  for (const name of await readdir(STAGE_DIR)) {
    await unlink(path.join(STAGE_DIR, name)).catch(() => undefined);
  }
  await cleanupStagedAttachments();
}

test("account file limit is enforced for sequential staging", async () => {
  await resetStage();
  const staged = [];
  for (let i = 0; i < 3; i += 1) staged.push(await stage(`seq${i}`));
  await assert.rejects(stage("overflow"), /STAGE_QUOTA_EXCEEDED/);
  assert.equal(stagedAttachmentStats().stagedFiles, 3);
  for (const s of staged) {
    assert.equal(await releaseStagedAttachment(secret, s.handle, account), true);
  }
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
  assert.equal((await diskFiles()).length, 0);
});

test("concurrent staging never overshoots the account file limit (reserved quota counts)", async () => {
  await resetStage();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => stage(`conc${i}`)),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 3);
  assert.equal(rejected.length, 2);
  for (const r of rejected) {
    assert.match((r as PromiseRejectedResult).reason?.message ?? "", /STAGE_QUOTA_EXCEEDED/);
  }
  assert.equal(stagedAttachmentStats().stagedFiles, 3);
  assert.equal((await diskFiles()).length, 3);
  for (const r of ok) {
    const s = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof stage>>>).value;
    assert.equal(await releaseStagedAttachment(secret, s.handle, account), true);
  }
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
  assert.equal((await diskFiles()).length, 0);
});

test("global file limit composes with per-account limits under concurrency", async () => {
  await resetStage();
  const a = await Promise.allSettled(
    Array.from({ length: 3 }, (_, i) => stage(`ga${i}`, { account })),
  );
  const b = await Promise.allSettled(
    Array.from({ length: 3 }, (_, i) => stage(`gb${i}`, { account: account2 })),
  );
  const aOk = a.filter((r) => r.status === "fulfilled");
  const bOk = b.filter((r) => r.status === "fulfilled");
  assert.equal(aOk.length, 3);
  assert.equal(bOk.length, 2); // global cap 5 = 3 + 2
  const rejectedB = b.filter((r) => r.status === "rejected");
  assert.equal(rejectedB.length, 1);
  assert.match((rejectedB[0] as PromiseRejectedResult).reason?.message ?? "", /STAGE_QUOTA_EXCEEDED/);
  assert.equal(stagedAttachmentStats().stagedFiles, 5);
  assert.equal((await diskFiles()).length, 5);
  for (const r of aOk) {
    await releaseStagedAttachment(secret, r.value.handle, account);
  }
  for (const r of bOk) {
    await releaseStagedAttachment(secret, r.value.handle, account2);
  }
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
});

test("cleanup rebuilds counters from pre-existing disk files (startup accounting)", async () => {
  await resetStage();
  const name = `${account}-${randomUUID()}.bin`;
  await writeFile(path.join(STAGE_DIR, name), Buffer.from("preexisting"));
  await cleanupStagedAttachments();
  assert.equal(stagedAttachmentStats().stagedFiles, 1);
  assert.equal(stagedAttachmentStats().stagedBytes, Buffer.byteLength("preexisting"));
  assert.equal(stagedAttachmentStats().trackedAccounts, 1);
  const staged = await stage("fresh-after-rebuild");
  assert.equal(stagedAttachmentStats().stagedFiles, 2);
  await releaseStagedAttachment(secret, staged.handle, account);
  // Drop the hand-placed file explicitly so later tests see a clean slate.
  await unlink(path.join(STAGE_DIR, name));
  await cleanupStagedAttachments();
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
});

test("cleanup deletes expired files and keeps fresh ones (default 24h TTL)", async () => {
  await resetStage();
  const staged = await stage("keep-me");
  const expiredName = `${account}-${randomUUID()}.bin`;
  const expiredPath = path.join(STAGE_DIR, expiredName);
  await writeFile(expiredPath, Buffer.from("old"));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(expiredPath, old, old);
  const removed = await cleanupStagedAttachments();
  assert.equal(removed, 1);
  await assert.rejects(stat(expiredPath), /ENOENT/);
  assert.equal(stagedAttachmentStats().stagedFiles, 1);
  assert.equal(stagedAttachmentStats().stagedBytes, staged.size);
  await releaseStagedAttachment(secret, staged.handle, account);
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
});

test("cleanup skips in-flight reserved files so commit does not double-count", async () => {
  await resetStage();
  let firstRead = true;
  const controlled = new Readable({
    read() {
      if (firstRead) {
        firstRead = false;
        this.push(Buffer.from("inflight"));
      }
    },
  });
  const pending = stageAttachmentStream({
    secret,
    account,
    filename: "inflight.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 8,
    stream: controlled,
  });
  const startedAt = Date.now();
  while ((await diskFiles()).length === 0 && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const removed = await cleanupStagedAttachments();
  assert.equal(removed, 0);
  assert.equal(stagedAttachmentStats().stagedFiles, 0); // still reserved, not committed
  controlled.push(null);
  const staged = await pending;
  assert.equal(staged.size, 8);
  assert.equal(stagedAttachmentStats().stagedFiles, 1); // counted exactly once
  assert.equal((await diskFiles()).length, 1);
  await releaseStagedAttachment(secret, staged.handle, account);
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
});

test("failed uploads release their reservation without corrupting committed counters", async () => {
  await resetStage();
  await assert.rejects(
    stageAttachmentStream({
      secret,
      account,
      filename: "bad.bin",
      mimeType: "application/octet-stream",
      kind: "attachment",
      declaredSize: 99,
      stream: Readable.from(Buffer.from("tiny")),
    }),
    /UPLOAD_SIZE_MISMATCH/,
  );
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
  assert.equal((await diskFiles()).length, 0);
  // The failed reservation must not have consumed account quota.
  const staged = await stage("after-failure");
  assert.equal(stagedAttachmentStats().stagedFiles, 1);
  await releaseStagedAttachment(secret, staged.handle, account);
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
});

test("counters never go negative and always match disk after concurrent bursts", async () => {
  await resetStage();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => stage(`burst${i}`)),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 3);
  await Promise.all(
    ok.map((r) => releaseStagedAttachment(secret, r.value.handle, account)),
  );
  await cleanupStagedAttachments();
  assert.equal((await diskFiles()).length, 0);
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
  assert.equal(stagedAttachmentStats().stagedBytes, 0);
  assert.equal(stagedAttachmentStats().trackedAccounts, 0);
});

test("release stays idempotent under concurrent double-release", async () => {
  await resetStage();
  const staged = await stage("double-release");
  const outcomes = await Promise.all([
    releaseStagedAttachment(secret, staged.handle, account),
    releaseStagedAttachment(secret, staged.handle, account),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
  assert.equal(stagedAttachmentStats().stagedBytes, 0);
});