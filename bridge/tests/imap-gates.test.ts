/**
 * MAILMAESTRO_IMAP_LIMITER_R3 — imap-gates unit tests (node:test).
 *
 * Exercises the limiter in isolation (no live IMAP): disabled-flag no-op,
 * per-key caps (global/host/company/account), FIFO + weighted fairness,
 * overflow rejection, timeout rejection, AbortSignal cancellation, release
 * idempotency, and metrics shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createImapGates,
  loadImapGatesConfigFromEnv,
  ImapBusyError,
  type ImapGates,
  type ImapGatesConfig,
} from "../src/imap-gates.js";

const baseCfg: ImapGatesConfig = {
  enabled: true,
  globalMax: 4,
  perHostMax: 3,
  perCompanyMax: 2,
  perAccountMax: 1,
  waitQueueMax: 20,
  interactiveWaitTimeoutMs: 500,
  backgroundWaitTimeoutMs: 1000,
};

const makeGates = (overrides: Partial<ImapGatesConfig> = {}): ImapGates =>
  createImapGates({ ...baseCfg, ...overrides });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("disabled flag returns a no-op release, never blocks even for same account", async () => {
  const g = createImapGates({ ...baseCfg, enabled: false, globalMax: 1, perAccountMax: 1 });
  const rs = await Promise.all([
    g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" }),
    g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" }),
    g.acquire({ host: "h", company: "c", account: "b", priority: "interactive" }),
  ]);
  assert.equal(rs.length, 3);
  rs.forEach((r) => r());
  assert.equal(g.stats().activeGlobal, 0);
});

test("per-account cap queues a second acquire until first releases", async () => {
  const g = makeGates();
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  let resolved = false;
  const p2 = g
    .acquire({ host: "h", company: "c", account: "a", priority: "interactive" })
    .then((r) => { resolved = true; return r; });
  await sleep(20);
  assert.equal(resolved, false);
  r1();
  const r2 = await p2;
  assert.equal(resolved, true);
  r2();
});

test("per-host cap blocks even with distinct accounts", async () => {
  const g = makeGates({ perHostMax: 2, perAccountMax: 1, perCompanyMax: 10, globalMax: 10 });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  const r2 = await g.acquire({ host: "h", company: "c", account: "b", priority: "interactive" });
  let resolved = false;
  const p3 = g
    .acquire({ host: "h", company: "c", account: "d", priority: "interactive" })
    .then((r) => { resolved = true; return r; });
  await sleep(20);
  assert.equal(resolved, false);
  r1();
  const r3 = await p3;
  assert.equal(resolved, true);
  r2(); r3();
});

test("per-company cap blocks across hosts", async () => {
  const g = makeGates({ perCompanyMax: 1, perAccountMax: 5, perHostMax: 10, globalMax: 10 });
  const r1 = await g.acquire({ host: "a.com", company: "co", account: "x@a", priority: "interactive" });
  let resolved = false;
  const p2 = g
    .acquire({ host: "b.com", company: "co", account: "y@b", priority: "interactive" })
    .then((r) => { resolved = true; return r; });
  await sleep(20);
  assert.equal(resolved, false);
  r1();
  const r2 = await p2;
  assert.equal(resolved, true);
  r2();
});

test("global cap blocks across everything", async () => {
  const g = makeGates({ globalMax: 2, perHostMax: 10, perCompanyMax: 10, perAccountMax: 10 });
  const r1 = await g.acquire({ host: "a", company: "1", account: "a", priority: "interactive" });
  const r2 = await g.acquire({ host: "b", company: "2", account: "b", priority: "interactive" });
  let resolved = false;
  const p3 = g
    .acquire({ host: "c", company: "3", account: "c", priority: "interactive" })
    .then((r) => { resolved = true; return r; });
  await sleep(20);
  assert.equal(resolved, false);
  r1();
  const r3 = await p3;
  assert.equal(resolved, true);
  r2(); r3();
});

test("fairness: interactive preferred but background admitted after 3 in a row", async () => {
  const g = makeGates({ globalMax: 1, perHostMax: 1, perCompanyMax: 1, perAccountMax: 1 });
  const r0 = await g.acquire({ host: "h", company: "c", account: "a0", priority: "interactive" });

  const order: string[] = [];
  const bg = g
    .acquire({ host: "h", company: "c", account: "bg", priority: "background" })
    .then((r) => { order.push("bg"); return r; });
  const mkI = (id: string) =>
    g.acquire({ host: "h", company: "c", account: id, priority: "interactive" })
      .then((r) => { order.push(id); return r; });
  const i1 = mkI("i1");
  const i2 = mkI("i2");
  const i3 = mkI("i3");
  const i4 = mkI("i4");

  r0();
  const releases = [];
  for (const p of [bg, i1, i2, i3, i4]) {
    const rel = await p;
    releases.push(rel);
    rel();
  }
  // First 3 interactive win, then background wins the 4th slot (fairness),
  // then the last interactive drains.
  assert.deepEqual(order, ["i1", "i2", "i3", "bg", "i4"]);
  releases.forEach((r) => r());
});

test("overflow: wait queue full rejects with IMAP_BUSY", async () => {
  const g = makeGates({ globalMax: 1, perAccountMax: 1, perCompanyMax: 10, perHostMax: 10, waitQueueMax: 2 });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  const p1 = g.acquire({ host: "h", company: "c", account: "b", priority: "interactive" });
  const p2 = g.acquire({ host: "h", company: "c", account: "c", priority: "interactive" });
  await assert.rejects(
    g.acquire({ host: "h", company: "c", account: "d", priority: "interactive" }),
    (err: unknown) => err instanceof ImapBusyError && (err as ImapBusyError).reason === "queue-full",
  );
  assert.equal(g.stats().rejected, 1);
  r1();
  (await p1)();
  (await p2)();
});

test("timeout: waiter rejected with IMAP_BUSY after wait timeout", async () => {
  const g = makeGates({ globalMax: 1, perAccountMax: 1, interactiveWaitTimeoutMs: 40 });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  const err = await g
    .acquire({ host: "h", company: "c", account: "b", priority: "interactive" })
    .catch((e) => e);
  assert.ok(err instanceof ImapBusyError);
  assert.equal((err as ImapBusyError).reason, "timeout");
  assert.equal(g.stats().timedOut, 1);
  r1();
});

test("cancellation: AbortSignal aborts a waiting acquire", async () => {
  const g = makeGates({ globalMax: 1, perAccountMax: 1, interactiveWaitTimeoutMs: 2000 });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  const ac = new AbortController();
  const p = g.acquire({
    host: "h", company: "c", account: "b", priority: "interactive", signal: ac.signal,
  }).catch((e) => e);
  setTimeout(() => ac.abort(), 10);
  const err = await p;
  assert.ok(err instanceof ImapBusyError);
  assert.equal((err as ImapBusyError).reason, "cancelled");
  assert.equal(g.stats().cancelled, 1);
  r1();
});

test("release is idempotent (safe to call multiple times)", async () => {
  const g = makeGates();
  const r = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  r(); r(); r();
  assert.equal(g.stats().activeGlobal, 0);
});

test("stats exposes bounded shape with active-by-host counts", async () => {
  const g = makeGates();
  const r1 = await g.acquire({ host: "imap.example.com", company: "c", account: "a", priority: "interactive" });
  const r2 = await g.acquire({ host: "imap.example.com", company: "c", account: "b", priority: "interactive" });
  const s = g.stats();
  assert.equal(s.enabled, true);
  assert.equal(s.activeGlobal, 2);
  assert.equal(s.activeByHost["imap.example.com"], 2);
  assert.equal(s.limits.globalMax, baseCfg.globalMax);
  assert.ok(s.waitMsP50 >= 0);
  assert.ok(s.waitMsP95 >= 0);
  r1(); r2();
});

test("env loader defaults enabled=false with documented caps", () => {
  const c = loadImapGatesConfigFromEnv({});
  assert.equal(c.enabled, false);
  assert.equal(c.globalMax, 32);
  assert.equal(c.perHostMax, 12);
  assert.equal(c.perCompanyMax, 4);
  assert.equal(c.perAccountMax, 2);
  assert.equal(c.waitQueueMax, 200);
});

test("env loader parses IMAP_GATES_ENABLED truthy variants", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE"]) {
    assert.equal(loadImapGatesConfigFromEnv({ IMAP_GATES_ENABLED: v }).enabled, true);
  }
  for (const v of ["0", "false", "no", "off", ""]) {
    assert.equal(loadImapGatesConfigFromEnv({ IMAP_GATES_ENABLED: v }).enabled, false);
  }
});

test("env loader ignores invalid numeric overrides and keeps defaults", () => {
  const c = loadImapGatesConfigFromEnv({
    IMAP_GLOBAL_MAX: "16",
    IMAP_PER_HOST_MAX: "abc",
  });
  assert.equal(c.globalMax, 16);
  assert.equal(c.perHostMax, 12);
});
