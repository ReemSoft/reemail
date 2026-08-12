import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LatestMessageOpenTracker, MessageOpenSingleFlight } from "../src/message-open-intent.js";

test("rapid A -> B -> C keeps only the latest queued message open current", () => {
  const now = 0;
  const tracker = new LatestMessageOpenTracker({ now: () => now });
  const a = tracker.register("company|account|session", 1, "inbox:1");
  const b = tracker.register("company|account|session", 2, "inbox:2");
  const c = tracker.register("company|account|session", 3, "inbox:3");

  assert.equal(a.isCurrent(), false);
  assert.equal(b.isCurrent(), false);
  assert.equal(c.isCurrent(), true);
});

test("A -> B -> A uses operation generations rather than permanently invalidating A", () => {
  const tracker = new LatestMessageOpenTracker();
  const firstA = tracker.register("company|account|session", 1, "inbox:1");
  tracker.register("company|account|session", 2, "inbox:2");
  const finalA = tracker.register("company|account|session", 3, "inbox:1");

  assert.equal(firstA.isCurrent(), true);
  assert.equal(finalA.isCurrent(), true);
});

test("older out-of-order arrivals cannot supersede the latest intent", () => {
  const tracker = new LatestMessageOpenTracker();
  const current = tracker.register("company|account|session", 3, "inbox:3");
  const delayedOldRequest = tracker.register("company|account|session", 1, "inbox:1");

  assert.equal(current.isCurrent(), true);
  assert.equal(delayedOldRequest.isCurrent(), false);
});

test("company, account, and browser-session scopes are isolated", () => {
  const tracker = new LatestMessageOpenTracker();
  const companyA = tracker.register("company-a|account|session", 2, "inbox:2");
  const companyB = tracker.register("company-b|account|session", 1, "inbox:1");
  const accountB = tracker.register("company-a|account-b|session", 1, "inbox:1");
  const sessionB = tracker.register("company-a|account|session-b", 1, "inbox:1");

  assert.equal(companyA.isCurrent(), true);
  assert.equal(companyB.isCurrent(), true);
  assert.equal(accountB.isCurrent(), true);
  assert.equal(sessionB.isCurrent(), true);
});

test("tracker stays bounded after 1000 independent rapid-selection scopes", () => {
  const tracker = new LatestMessageOpenTracker({ maxScopes: 64 });
  for (let index = 0; index < 1000; index++) {
    tracker.register(`company|account-${index}|session`, 1, "inbox:1");
  }
  assert.equal(tracker.stats().scopes, 64);
});

test("expired scope state is removed opportunistically without timers", () => {
  let now = 0;
  const tracker = new LatestMessageOpenTracker({ maxAgeMs: 100, now: () => now });
  tracker.register("old", 1, "inbox:1");
  now = 101;
  tracker.register("new", 1, "inbox:1");
  assert.equal(tracker.stats().scopes, 1);
});

test("capacity or TTL eviction fails open instead of cancelling a valid request", () => {
  let now = 0;
  const tracker = new LatestMessageOpenTracker({ maxScopes: 1, maxAgeMs: 10, now: () => now });
  const evictedForCapacity = tracker.register("first", 1, "inbox:1");
  tracker.register("second", 1, "inbox:2");
  assert.equal(evictedForCapacity.isCurrent(), true);

  const evictedForAge = tracker.register("age", 1, "inbox:3");
  now = 11;
  tracker.stats();
  assert.equal(evictedForAge.isCurrent(), true);
});

test("A -> B -> A shares the active A operation and performs one expensive worker", async () => {
  const flights = new MessageOpenSingleFlight<string>();
  let workers = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = flights.run("scope|inbox:1", async () => {
    workers++;
    await blocked;
    return "A";
  });
  const final = flights.run("scope|inbox:1", async () => {
    workers++;
    return "duplicate";
  });
  release();

  assert.deepEqual(await first, { value: "A", leader: true });
  assert.deepEqual(await final, { value: "A", leader: false });
  assert.equal(workers, 1);
  assert.equal(flights.stats().active, 0);
});

test("A -> A duplicate clicks share one active operation", async () => {
  const flights = new MessageOpenSingleFlight<string>();
  let workers = 0;
  const first = flights.run("scope|inbox:1", async () => {
    workers++;
    await Promise.resolve();
    return "A";
  });
  const duplicate = flights.run("scope|inbox:1", async () => {
    workers++;
    return "duplicate";
  });
  assert.equal((await first).value, "A");
  assert.deepEqual(await duplicate, { value: "A", leader: false });
  assert.equal(workers, 1);
});

test("100 rapid switches retain one latest-intent entry", () => {
  const tracker = new LatestMessageOpenTracker();
  let last = tracker.register("company|account|session", 1, "inbox:1");
  for (let generation = 2; generation <= 100; generation++) {
    last = tracker.register("company|account|session", generation, `inbox:${generation}`);
  }
  assert.equal(last.isCurrent(), true);
  assert.deepEqual(tracker.stats(), { scopes: 1 });
});

test("serial A -> B -> C starts A and C but skips obsolete queued B", async () => {
  const tracker = new LatestMessageOpenTracker();
  const started: string[] = [];
  let releaseA!: () => void;
  const aBlocked = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let chain = Promise.resolve();
  const enqueue = (name: string, current: () => boolean, worker?: () => Promise<void>) => {
    const result = chain.then(async () => {
      if (!current()) return;
      started.push(name);
      await worker?.();
    });
    chain = result.catch(() => undefined);
    return result;
  };

  const a = tracker.register("company|account|session", 1, "inbox:1");
  const aRun = enqueue("A", a.isCurrent, () => aBlocked);
  await Promise.resolve();
  const b = tracker.register("company|account|session", 2, "inbox:2");
  const bRun = enqueue("B", b.isCurrent);
  const c = tracker.register("company|account|session", 3, "inbox:3");
  const cRun = enqueue("C", c.isCurrent);
  releaseA();
  await Promise.all([aRun, bRun, cRun]);
  assert.deepEqual(started, ["A", "C"]);
});

test("failed active work is removed deterministically and can be retried", async () => {
  const flights = new MessageOpenSingleFlight<string>();
  await assert.rejects(flights.run("scope|inbox:1", async () => Promise.reject(new Error("A"))));
  assert.deepEqual(flights.stats(), { active: 0 });
  assert.deepEqual(await flights.run("scope|inbox:1", async () => "retry"), {
    value: "retry",
    leader: true,
  });
});

test("intent registration precedes the existing gate and no cancel endpoint is added", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/index.ts"), "utf8");
  assert.match(
    source,
    /app\.post\("\/api\/message", requireKey, registerMessageOpenIntent, messageGate,/,
  );
  assert.doesNotMatch(source, /api\/message-(?:cancel|supersede)/);
});

test("the shared connection checks current intent immediately before mailbox lock", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/imap-connection.ts"), "utf8");
  const start = source.indexOf("export async function withAccountMailbox");
  const end = source.indexOf("\n}", start);
  const implementation = source.slice(start, end);
  assert.match(
    implementation,
    /if \(shouldStart && !shouldStart\(\)\) throw new MessageOpenSupersededError\(\);[\s\S]*getMailboxLock/,
  );
});
