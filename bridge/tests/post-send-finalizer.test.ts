import assert from "node:assert/strict";
import test from "node:test";
import { PostSendFinalizerQueue } from "../src/post-send-finalizer.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("post-send finalizer bounds global, per-account, and queued work", async () => {
  const queue = new PostSendFinalizerQueue(2, 1, 2);
  const first = deferred();
  const second = deferred();
  const third = deferred();
  assert.equal(
    queue.enqueue("a", () => first.promise),
    true,
  );
  assert.equal(
    queue.enqueue("a", () => second.promise),
    true,
  );
  assert.equal(
    queue.enqueue("b", () => third.promise),
    true,
  );
  assert.deepEqual(queue.stats(), { active: 2, queued: 1, rejected: 0, tracked: 0 });
  assert.equal(
    queue.enqueue("c", async () => undefined),
    true,
  );
  assert.equal(
    queue.enqueue("d", async () => undefined),
    false,
  );
  assert.deepEqual(queue.stats(), { active: 2, queued: 2, rejected: 1, tracked: 0 });

  first.resolve();
  third.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { active: 1, queued: 0, rejected: 1, tracked: 0 });
  second.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { active: 0, queued: 0, rejected: 1, tracked: 0 });
});

test("tracked jobs are account-bound, terminal, expiring, and bounded", async () => {
  let now = 1_000;
  const queue = new PostSendFinalizerQueue(1, 1, 2, 2, 100, () => now);
  const first = queue.enqueueTracked("account-a", async () => ({
    state: "saved",
    source: "provider",
  }));
  assert.equal(first.state, "pending");
  assert.equal(first.jobId.length >= 32, true);
  assert.equal(queue.getStatus("account-b", first.jobId), undefined);
  assert.equal(queue.getStatus("account-a", "not-a-real-job-id"), undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.getStatus("account-a", first.jobId), {
    jobId: first.jobId,
    state: "saved",
    source: "provider",
  });

  const second = queue.enqueueTracked("account-a", async () => ({
    state: "failed",
    code: "APPEND_FAILED",
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queue.getStatus("account-a", second.jobId)?.state, "failed");
  const third = queue.enqueueTracked("account-a", async () => ({ state: "saved" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queue.stats().tracked, 2);
  assert.equal(queue.getStatus("account-a", first.jobId), undefined, "oldest terminal is evicted");
  assert.equal(queue.getStatus("account-a", third.jobId)?.state, "saved");

  now += 101;
  assert.equal(queue.getStatus("account-a", second.jobId), undefined);
  assert.equal(queue.getStatus("account-a", third.jobId), undefined);
  assert.equal(queue.stats().tracked, 0);
});

test("tracked queue rejection is explicit and does not execute work", async () => {
  const queue = new PostSendFinalizerQueue(1, 1, 0, 2);
  let ran = false;
  const result = queue.enqueueTracked("account", async () => {
    ran = true;
    return { state: "saved" };
  });
  assert.equal(result.accepted, false);
  assert.equal(result.state, "rejected");
  assert.equal(queue.getStatus("account", result.jobId)?.state, "rejected");
  assert.equal(ran, false);
});
