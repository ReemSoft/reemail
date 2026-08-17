/**
 * Explicit staged-handle release endpoint (B) + validateStagedHandle.
 *
 * POST /api/staged-release lets the app proactively release staged handles
 * when the user removes an attachment/inline image or discards a draft. It
 * must validate every handle before releasing any (no partial release), dedupe
 * duplicate handles, and reject tampered/foreign/expired payloads.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const endpoint = source.slice(
  source.indexOf("const StagedReleasePayloadSchema"),
  source.indexOf("// ---- Drafts"),
);

const testStageDir = await mkdtemp(path.join(tmpdir(), "mailmaestro-stage-release-"));
process.env.MAIL_STAGE_DIR = testStageDir;

const {
  releaseStagedAttachments,
  releaseStagedAttachment,
  stageAttachmentStream,
  stagedAttachmentStats,
  validateStagedHandle,
} = await import("../src/staged-attachments.js");

const secret = "release-test-secret";
const account = "a".repeat(64);

after(async () => {
  await rm(testStageDir, { recursive: true, force: true });
  delete process.env.MAIL_STAGE_DIR;
});

test("endpoint validates every handle before releasing any (no partial release)", () => {
  const validateIndex = endpoint.indexOf("validateStagedHandle(BRIDGE_API_KEY, handle, account)");
  const releaseIndex = endpoint.indexOf("releaseStagedAttachments(BRIDGE_API_KEY");
  assert.ok(validateIndex !== -1, "must pre-validate every handle");
  assert.ok(releaseIndex !== -1, "must release after validation");
  assert.ok(validateIndex < releaseIndex, "validation must precede release");
  assert.match(endpoint, /for \(const handle of uniqueHandles\)/);
});

test("endpoint returns { ok: true, released } on success", () => {
  assert.match(endpoint, /res\.json\(\{ ok: true, released \}\)/);
});

test("endpoint maps invalid handles to 400 INVALID_STAGE_HANDLE", () => {
  assert.match(endpoint, /res\.status\(400\)\.json\(\{ ok: false, error: "INVALID_STAGE_HANDLE" \}\)/);
});

test("endpoint rejects empty and oversized handle lists as INVALID_PAYLOAD", () => {
  assert.match(endpoint, /handles: z\.array\(z\.string\(\)\.min\(20\)\.max\(32 \* 1024\)\)\.min\(1\)\.max\(64\)/);
  assert.match(endpoint, /error instanceof z\.ZodError \? "INVALID_PAYLOAD"/);
});

test("validateStagedHandle accepts a genuine handle and rejects tampering", async () => {
  const staged = await stageAttachmentStream({
    secret,
    account,
    filename: "genuine.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 1,
    stream: Readable.from(Buffer.from("x")),
  });
  assert.equal(validateStagedHandle(secret, staged.handle, account), true);
  assert.equal(validateStagedHandle(secret, `${staged.handle}x`, account), false);
  await releaseStagedAttachment(secret, staged.handle, account);
});

test("validateStagedHandle rejects foreign-account and expired handles", async () => {
  const staged = await stageAttachmentStream({
    secret,
    account,
    filename: "bound.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 1,
    stream: Readable.from(Buffer.from("y")),
    now: 1,
  });
  assert.equal(validateStagedHandle(secret, staged.handle, "b".repeat(64), 2), false);
  assert.equal(validateStagedHandle(secret, staged.handle, account, staged.expiresAt), false);
  assert.equal(validateStagedHandle(secret, staged.handle, account, 2), true);
  await releaseStagedAttachment(secret, staged.handle, account, 2);
});

test("releaseStagedAttachments dedupes duplicate handles", async () => {
  const a = await stageAttachmentStream({
    secret,
    account,
    filename: "dup-a.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 1,
    stream: Readable.from(Buffer.from("a")),
  });
  const b = await stageAttachmentStream({
    secret,
    account,
    filename: "dup-b.bin",
    mimeType: "application/octet-stream",
    kind: "attachment",
    declaredSize: 1,
    stream: Readable.from(Buffer.from("b")),
  });
  assert.equal(stagedAttachmentStats().stagedFiles, 2);
  assert.equal(
    await releaseStagedAttachments(secret, [a.handle, b.handle, a.handle, b.handle], account),
    2,
  );
  assert.equal(await releaseStagedAttachments(secret, [a.handle, b.handle], account), 0);
  assert.equal(stagedAttachmentStats().stagedFiles, 0);
});
