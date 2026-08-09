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
  assert.deepEqual(queue.stats(), { active: 2, queued: 1, rejected: 0 });
  assert.equal(
    queue.enqueue("c", async () => undefined),
    true,
  );
  assert.equal(
    queue.enqueue("d", async () => undefined),
    false,
  );
  assert.deepEqual(queue.stats(), { active: 2, queued: 2, rejected: 1 });

  first.resolve();
  third.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { active: 1, queued: 0, rejected: 1 });
  second.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { active: 0, queued: 0, rejected: 1 });
});
