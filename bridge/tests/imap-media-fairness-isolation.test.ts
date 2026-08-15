/**
 * MAILMAESTRO — PER-ACCOUNT MEDIA FAIRNESS ISOLATION gate tests.
 *
 * Deterministic (no live IMAP) proof that the foreground-MEDIA fairness budget
 * is scoped to the account, not the process:
 *
 *   * one account's MEDIA admissions never increment another account's streak
 *   * one account's lower-priority admissions never reset another account's
 *     streak or rotate another account's lower-class cursor
 *   * unrelated MEDIA admissions can never cause account A's BACKGROUND to be
 *     admitted before account A's already-waiting MEDIA
 *   * when an account's streak is at the limit but it has no lower-priority
 *     waiter of its own, its MEDIA still runs — other accounts cannot claim
 *     the yield
 *   * accounts reach the limit independently and each receives its own yield
 *   * no cross-account starvation, BODY red line intact
 *   * per-account fairness state is removed once the account returns to idle
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createImapGates,
  type ImapGates,
  type ImapGatesConfig,
  type ImapPriority,
  type ImapGateRelease,
} from "../src/imap-gates.js";

const BASE_CFG: ImapGatesConfig = {
  enabled: true,
  globalMax: 20,
  perHostMax: 20,
  perCompanyMax: 20,
  perAccountMax: 2,
  waitQueueMax: 50,
  interactiveWaitTimeoutMs: 5000,
  backgroundWaitTimeoutMs: 5000,
};

const makeGates = (overrides: Partial<ImapGatesConfig> = {}): ImapGates =>
  createImapGates({ ...BASE_CFG, ...overrides });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HOST = "h";
const COMPANY = "c";

test("1. BODY always outranks MEDIA on a shared slot", async () => {
  const g = makeGates({ globalMax: 1, perHostMax: 10, perCompanyMax: 10 });
  const r0 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });

  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const all = Promise.all([track("media2", "media"), track("body1", "body")]);
  r0();
  await all;
  assert.deepEqual(order, ["body1", "media2"], "queued MEDIA must never overtake a BODY open");
});

test("2. BODY reservation unchanged: active background never blocks an incoming BODY", async () => {
  const g = makeGates();
  const bg = await g.acquire({
    host: HOST,
    company: COMPANY,
    account: "a",
    priority: "background",
  });
  let resolved = false;
  const body = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "body" })
    .then((r) => {
      resolved = true;
      return r;
    });
  await sleep(20);
  assert.equal(resolved, true, "BODY must not wait behind an active background op");
  assert.equal(g.stats().activeGlobal, 2, "1 non-body + 1 body = 2");
  bg();
  (await body)();
});

test("3. same-account MEDIA priority at streak 0: MEDIA beats waiting background", async () => {
  const g = makeGates({ globalMax: 1 });
  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const r0 = await g.acquire({
    host: HOST,
    company: COMPANY,
    account: "z0",
    priority: "interactive",
  });
  const m_A = track("m_A", "media");
  const bg_A = track("bg_A", "background");
  await sleep(20);
  r0();
  await Promise.all([m_A, bg_A]);
  assert.deepEqual(
    order,
    ["m_A", "bg_A"],
    "waiting MEDIA beats waiting background for the same account",
  );
});

test("5. Account B media admissions do not increment Account A's streak", async () => {
  const g = makeGates();
  const order: string[] = [];
  // A holds its non-body slot with a background op so A's MEDIA + BACKGROUND queue.
  const a0 = await g.acquire({
    host: HOST,
    company: COMPANY,
    account: "a",
    priority: "background",
  });
  order.push("a0");
  const m_A = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" })
    .then((r) => {
      order.push("m_A");
      r();
    });
  const bg_A = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "background" })
    .then((r) => {
      order.push("bg_A");
      r();
    });
  // B/C/D each admit MEDIA on their own accounts (fast path). None may touch A's streak.
  const bReleases: ImapGateRelease[] = [];
  for (const acct of ["b", "c", "d"]) {
    const rel = await g.acquire({ host: HOST, company: COMPANY, account: acct, priority: "media" });
    bReleases.push(rel);
  }
  bReleases.forEach((r) => r());

  a0();
  await Promise.all([m_A, bg_A]);
  assert.deepEqual(
    order,
    ["a0", "m_A", "bg_A"],
    "A's waiting MEDIA still beats A's background: B/C/D media never advanced A's streak",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("6. Account B lower admission does not reset Account A's streak", async () => {
  const g = makeGates();
  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });
  order.push("m1");
  const m2 = track("m2", "media");
  const m3 = track("m3", "media");
  const bg_A = track("bg_A", "background");
  const m4_A = track("m4_A", "media");

  // B admits lower-priority work (background) while A's burst is queued.
  const bgB = await g.acquire({
    host: HOST,
    company: COMPANY,
    account: "b",
    priority: "background",
  });
  bgB();

  m1();
  await Promise.all([m2, m3, bg_A, m4_A]);
  assert.deepEqual(
    order,
    ["m1", "m2", "m3", "bg_A", "m4_A"],
    "A's streak reached 3 and its own yield still fires after B's lower admission",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("7. Account B lower activity does not change Account A's lower-class cursor", async () => {
  const g = makeGates();
  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  // A builds its burst: streak reaches 3 with transfer + background + 4th media queued.
  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });
  order.push("m1");
  const m2 = track("m2", "media");
  const m3 = track("m3", "media");
  const transfer_A = track("transfer_A", "transfer");
  const bg_A = track("bg_A", "background");
  const m4_A = track("m4_A", "media");

  // B performs several lower-priority admissions — must not rotate A's cursor.
  for (const acct of ["b1", "b2", "b3"]) {
    const rel = await g.acquire({
      host: HOST,
      company: COMPANY,
      account: acct,
      priority: "background",
    });
    rel();
  }

  m1();
  await Promise.all([m2, m3, transfer_A, bg_A, m4_A]);
  // A's cursor starts at 0: the yield scans interactive (empty) -> transfer first.
  assert.ok(
    order.indexOf("transfer_A") < order.indexOf("bg_A"),
    "A's own cursor (0) selects transfer over background for A's yield, despite B's lower admissions",
  );
  assert.ok(
    order.indexOf("transfer_A") < order.indexOf("m4_A"),
    "A's bounded yield fires before the account's 4th media op",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("8. three unrelated MEDIA admissions cannot cause A background to beat A waiting media", async () => {
  const g = makeGates();
  const order: string[] = [];
  // A: waiting MEDIA + waiting BACKGROUND, streak 0 (held slot is A's own background).
  const a0 = await g.acquire({
    host: HOST,
    company: COMPANY,
    account: "a",
    priority: "background",
  });
  order.push("a0");
  const m_A = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" })
    .then((r) => {
      order.push("m_A");
      r();
    });
  const bg_A = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "background" })
    .then((r) => {
      order.push("bg_A");
      r();
    });
  // Exactly the audit scenario: accounts B/C/D each admit MEDIA.
  for (const acct of ["b", "c", "d"]) {
    const rel = await g.acquire({ host: HOST, company: COMPANY, account: acct, priority: "media" });
    rel();
  }

  a0();
  await Promise.all([m_A, bg_A]);
  assert.deepEqual(
    order,
    ["a0", "m_A", "bg_A"],
    "B/C/D media never exhaust A's streak, so A's MEDIA still beats A's BACKGROUND",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("9. A streak=3 with no A lower waiter: A MEDIA runs even though B background is waiting", async () => {
  const g = makeGates({ globalMax: 1, perHostMax: 10, perCompanyMax: 10 });
  const order: string[] = [];
  const track = (label: string, account: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account, priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });
  order.push("m1");
  const m2 = track("m2", "a", "media");
  const m3 = track("m3", "a", "media");
  const m4_A = track("m4_A", "a", "media");
  const bgB = track("bgB", "b", "background");
  await sleep(20);

  m1();
  await sleep(50);
  // Cascade: m2 (streak 2), m3 (streak 3), then the yield scan finds NO A lower
  // waiter, so A's MEDIA runs — B's queued background cannot claim A's yield.
  assert.ok(order[3] === "m4_A", "A's 4th media runs at the streak limit with no A lower work");
  assert.ok(order[4] === "bgB", "B background proceeds only after A's media");
  await bgB;
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("10. A and B independently reach streak 3 and each receive their own yield", async () => {
  const g = makeGates();
  const order: string[] = [];
  const releases: ImapGateRelease[] = [];
  const hold = async (label: string, account: string) => {
    const rel = await g.acquire({ host: HOST, company: COMPANY, account, priority: "media" });
    order.push(label);
    releases.push(rel);
  };
  const track = (label: string, account: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account, priority }).then((rel) => {
      order.push(label);
      rel();
    });

  await hold("m1", "a");
  const m2 = track("m2", "a", "media");
  const m3 = track("m3", "a", "media");
  const bg_A = track("bg_A", "a", "background");
  const m4_A = track("m4_A", "a", "media");

  await hold("n1", "b");
  const n2 = track("n2", "b", "media");
  const n3 = track("n3", "b", "media");
  const bg_B = track("bg_B", "b", "background");
  const n4_B = track("n4_B", "b", "media");

  await sleep(20);
  releases[0](); // m1 -> m2 (a streak 2) ... then cascade
  await sleep(50);
  releases[1](); // n1 -> n2 (b streak 2) ... then cascade
  await sleep(50);

  assert.ok(order.indexOf("bg_A") < order.indexOf("m4_A"), "A receives its own bounded yield");
  assert.ok(
    order.indexOf("bg_B") < order.indexOf("n4_B"),
    "B independently receives its own bounded yield",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("11. cross-account: B's media traffic cannot starve A's lower work", async () => {
  const g = makeGates();
  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  // A holds its only non-body slot with MEDIA; A's own BACKGROUND waits behind it.
  const aM = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });
  order.push("aM");
  const bg_A = track("bg_A", "background");
  // B/C/D continuously admit MEDIA on their own accounts (concurrent traffic).
  const bReleases: ImapGateRelease[] = [];
  for (const acct of ["b", "c", "d"]) {
    const rel = await g.acquire({ host: HOST, company: COMPANY, account: acct, priority: "media" });
    bReleases.push(rel);
  }
  bReleases.forEach((r) => r());
  await sleep(20);
  assert.deepEqual(order, ["aM"], "A's background stays queued behind A's own media");

  aM();
  await bg_A;
  assert.equal(
    order[1],
    "bg_A",
    "A's background is served as soon as A's media releases; B never starved it",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("17. per-account fairness state is cleaned once the account returns to idle", async () => {
  const g = makeGates();
  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  // Burst 1: two media admissions leave the account's streak at 2.
  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });
  order.push("m1");
  const m2 = track("m2", "media");
  m1();
  await m2;
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0, "account a fully drained");

  // Burst 2: if the stale streak (2) survived, m3 would hit 3 and yield bg first.
  const m3 = track("m3", "media");
  const bg = track("bg", "background");
  const m4 = track("m4", "media");
  await sleep(20);
  assert.deepEqual(
    order,
    ["m1", "m2", "m3", "m4", "bg"],
    "idle cleanup cleared the streak: m3 starts a fresh burst and MEDIA stays foreground",
  );
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});
