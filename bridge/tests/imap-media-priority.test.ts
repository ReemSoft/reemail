/**
 * MAILMAESTRO — FOREGROUND MEDIA PRIORITY gate tests.
 *
 * Deterministic (no live IMAP) proof of the foreground-MEDIA policy at the
 * ADMISSION level, layered on top of the BODY reservation guarantee:
 *
 *   * BODY always outranks MEDIA (reserved class, checked before everything)
 *   * MEDIA is the foreground non-body class: it outranks interactive /
 *     transfer / background, even when a lower-priority waiter arrived first
 *   * bounded fairness: after MEDIA_STREAK_LIMIT (= 3) consecutive media
 *     admissions, one already-waiting lower-priority non-body request is
 *     served next, so media can never starve the lower classes forever
 *   * per-account caps are unchanged while media is foreground:
 *     media-per-account <= 1, non-body-per-account <= 1, total <= 2
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
  // Prime the sole global slot with a media op so both waiters queue.
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

test("2. MEDIA outranks a background waiter that arrived earlier", async () => {
  const g = makeGates();
  // m1 occupies the account's only non-body slot.
  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });

  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  // Background queues FIRST, media arrives after it.
  const bg = track("bg1", "background");
  const m2 = track("m2", "media");
  await sleep(20);
  assert.deepEqual(order, [], "both waiters must still be queued behind m1");

  m1();
  await Promise.all([bg, m2]);
  assert.deepEqual(order, ["m2", "bg1"], "media (arrived later) is served before background");
});

test("3. MEDIA outranks transfer and interactive too", async () => {
  const g = makeGates();
  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });

  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ host: HOST, company: COMPANY, account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const all = Promise.all([
    track("t1", "transfer"),
    track("i1", "interactive"),
    track("m2", "media"),
  ]);
  await sleep(20);
  assert.deepEqual(order, [], "all waiters must still be queued behind m1");

  m1();
  await all;
  assert.deepEqual(
    order,
    ["m2", "i1", "t1"],
    "media first; then the lower classes rotate (interactive, transfer)",
  );
});

test("4. bounded fairness: after 3 media admissions a waiting lower-priority request is served next", async () => {
  // Three media ops on distinct accounts occupy both a per-account slot and
  // the company cap (3), so a background waiter and a 4th media waiter queue.
  // Releasing m1 makes both eligible at once; the media streak is at the
  // limit, so the background waiter is served before m4.
  const g = makeGates({ perCompanyMax: 3, perHostMax: 10 });

  const releases: ImapGateRelease[] = [];
  const order: string[] = [];
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

  await hold("m1", "a1"); // media streak 1, company 1
  await hold("m2", "a2"); // media streak 2, company 2
  await hold("m3", "a3"); // media streak 3, company 3

  const bg1 = track("bg1", "a4", "background"); // queued: company cap full
  const m4 = track("m4", "a1", "media"); // queued: a1 slot held by m1
  await sleep(20);
  assert.deepEqual(order, ["m1", "m2", "m3"], "bg1 and m4 must stay queued");

  // m1 releases: m4 (eligible) and bg1 (eligible) compete. The media streak is
  // maxed, so the fairness yield serves bg1 before m4.
  releases[0]();
  await Promise.all([bg1, m4]);
  assert.deepEqual(
    order,
    ["m1", "m2", "m3", "bg1", "m4"],
    "at streak limit the lower-priority waiter is served before the 4th media",
  );

  releases[1]();
  releases[2]();
  await sleep(20);
  assert.equal(g.stats().activeGlobal, 0);
});

test("5. per-account caps unchanged while media is foreground", async () => {
  const g = makeGates();
  const m1 = await g.acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" });

  let m2Resolved = false;
  let t1Resolved = false;
  const m2 = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "media" })
    .then((r) => {
      m2Resolved = true;
      return r;
    });
  const t1 = g
    .acquire({ host: HOST, company: COMPANY, account: "a", priority: "transfer" })
    .then((r) => {
      t1Resolved = true;
      return r;
    });
  await sleep(20);
  assert.equal(m2Resolved, false, "second media must queue (media cap = 1)");
  assert.equal(t1Resolved, false, "transfer must queue (non-body cap = 1)");
  assert.equal(g.stats().activeGlobal, 1, "only the one non-body op is active");
  assert.equal(g.stats().waitingMedia, 1);
  assert.equal(g.stats().waitingTransfer, 1);

  // Media is foreground: the queued second media is admitted before transfer.
  m1();
  const m2r = await m2;
  assert.equal(m2Resolved, true);
  assert.equal(t1Resolved, false, "transfer still waits behind the admitted media");
  assert.equal(g.stats().activeGlobal, 1, "still exactly one non-body op active");

  // Releasing the media frees the non-body slot; transfer is admitted next.
  m2r();
  const t1r = await t1;
  assert.equal(t1Resolved, true);
  t1r();
  assert.equal(g.stats().activeGlobal, 0);
});
