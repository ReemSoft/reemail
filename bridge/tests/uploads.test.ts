import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Force UPLOAD_DIR into an isolated temp dir BEFORE importing uploads.ts so
// mkdirSync at module load hits a per-test scratch space, not /tmp/mailmaestro-uploads.
const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "mm-upload-test-"));
process.env.MAIL_UPLOAD_DIR = TMP_ROOT;

const { cleanupFiles, startupCleanup, randomStoredName, UPLOAD_DIR } = await import("../src/uploads.js");
const { createSendGates } = await import("../src/concurrency.js");

test("UPLOAD_DIR resolves to the env-provided path", () => {
  assert.equal(UPLOAD_DIR, TMP_ROOT);
});

test("randomStoredName produces unique names on the sanctioned prefix", () => {
  const a = randomStoredName();
  const b = randomStoredName();
  assert.notEqual(a, b);
  assert.match(a, /^up_[a-z0-9]+_[0-9a-f-]+\.bin$/);
});

test("cleanupFiles removes only files inside the sanctioned dir", async () => {
  const inside = path.join(UPLOAD_DIR, randomStoredName());
  const outside = path.join(os.tmpdir(), `outside_${Date.now()}.txt`);
  await fs.writeFile(inside, "x");
  await fs.writeFile(outside, "y");
  try {
    await cleanupFiles([{ path: inside }, { path: outside }, undefined, null]);
    await assert.rejects(() => fs.access(inside), /ENOENT/);
    // Outside file must still be there — cleanup refuses to touch it.
    await fs.access(outside);
  } finally {
    await fs.unlink(outside).catch(() => {});
  }
});

test("cleanupFiles is idempotent on missing paths", async () => {
  const ghost = path.join(UPLOAD_DIR, "does-not-exist.bin");
  // Should not throw.
  await cleanupFiles([{ path: ghost }]);
});

test("startupCleanup removes files older than maxAgeMs and leaves fresh ones", async () => {
  const fresh = path.join(UPLOAD_DIR, `fresh_${randomStoredName()}`);
  const stale = path.join(UPLOAD_DIR, `stale_${randomStoredName()}`);
  await fs.writeFile(fresh, "f");
  await fs.writeFile(stale, "s");
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(stale, past, past);
  const removed = await startupCleanup(60 * 60 * 1000);
  assert.ok(removed >= 1);
  await assert.rejects(() => fs.access(stale), /ENOENT/);
  await fs.access(fresh);
  await fs.unlink(fresh).catch(() => {});
});

test("send gates enforce global and per-key caps and release cleanly", () => {
  const gates = createSendGates({ globalMax: 3, perKeyMax: 2 });
  assert.equal(gates.tryAcquire("a"), true); // a:1 g:1
  assert.equal(gates.tryAcquire("a"), true); // a:2 g:2
  assert.equal(gates.tryAcquire("a"), false); // per-key cap
  assert.equal(gates.tryAcquire("b"), true); // b:1 g:3
  assert.equal(gates.tryAcquire("b"), false); // global cap
  gates.release("a");
  assert.equal(gates.inFlight(), 2);
  assert.equal(gates.tryAcquire("b"), true); // now allowed under global cap
  gates.release("a");
  gates.release("b");
  gates.release("b");
  assert.equal(gates.inFlight(), 0);
});

test("send gates never underflow global counter on extra release", () => {
  const gates = createSendGates({ globalMax: 1, perKeyMax: 1 });
  gates.release("nope"); // should be a no-op
  assert.equal(gates.inFlight(), 0);
  assert.equal(gates.tryAcquire("k"), true);
});
