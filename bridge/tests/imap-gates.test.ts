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
    .then((r) => {
      resolved = true;
      return r;
    });
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
    .then((r) => {
      resolved = true;
      return r;
    });
  await sleep(20);
  assert.equal(resolved, false);
  r1();
  const r3 = await p3;
  assert.equal(resolved, true);
  r2();
  r3();
});

test("per-company cap blocks across hosts", async () => {
  const g = makeGates({ perCompanyMax: 1, perAccountMax: 5, perHostMax: 10, globalMax: 10 });
  const r1 = await g.acquire({
    host: "a.com",
    company: "co",
    account: "x@a",
    priority: "interactive",
  });
  let resolved = false;
  const p2 = g
    .acquire({ host: "b.com", company: "co", account: "y@b", priority: "interactive" })
    .then((r) => {
      resolved = true;
      return r;
    });
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
    .then((r) => {
      resolved = true;
      return r;
    });
  await sleep(20);
  assert.equal(resolved, false);
  r1();
  const r3 = await p3;
  assert.equal(resolved, true);
  r2();
  r3();
});

test("round-robin: non-body classes (interactive/media/transfer/background) share the one slot fairly", async () => {
  const g = makeGates({
    globalMax: 1,
    perHostMax: 1,
    perCompanyMax: 1,
    perAccountMax: 1,
    interactiveWaitTimeoutMs: 5000,
    backgroundWaitTimeoutMs: 5000,
  });
  const r0 = await g.acquire({ host: "h", company: "c", account: "a0", priority: "interactive" });

  // Every waiter auto-releases on admission so the next slot opens. This
  // captures the admission order without deadlocking on await order. Only
  // interactive + background are queued; the round-robin rotation walks
  // [interactive, media, transfer, background] and serves the first eligible,
  // so media/transfer (empty) just advance the cursor.
  const order: string[] = [];
  const track = (label: string, priority: "interactive" | "background") =>
    g.acquire({ host: "h", company: "c", account: label, priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const all = Promise.all([
    track("bg", "background"),
    track("i1", "interactive"),
    track("i2", "interactive"),
    track("i3", "interactive"),
    track("i4", "interactive"),
  ]);

  r0();
  await all;
  // The priming r0 was admitted on the fast path, which advances the
  // non-body cursor from 0 -> 1 (media). Drain therefore starts the rotation
  // at media, walks to transfer (empty), then background -> bg is served
  // first; the interactive waiters drain in order after that.
  assert.deepEqual(order, ["bg", "i1", "i2", "i3", "i4"]);
});

test("overflow: wait queue full rejects with IMAP_BUSY", async () => {
  const g = makeGates({
    globalMax: 1,
    perAccountMax: 1,
    perCompanyMax: 10,
    perHostMax: 10,
    waitQueueMax: 2,
  });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  const p1 = g.acquire({ host: "h", company: "c", account: "b", priority: "interactive" });
  const p2 = g.acquire({ host: "h", company: "c", account: "c", priority: "interactive" });
  await assert.rejects(
    g.acquire({ host: "h", company: "c", account: "d", priority: "interactive" }),
    (err: unknown) =>
      err instanceof ImapBusyError && (err as ImapBusyError).reason === "queue-full",
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
  const p = g
    .acquire({
      host: "h",
      company: "c",
      account: "b",
      priority: "interactive",
      signal: ac.signal,
    })
    .catch((e) => e);
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
  r();
  r();
  r();
  assert.equal(g.stats().activeGlobal, 0);
});

test("stats exposes bounded shape and NEVER leaks host / account / company identifiers", async () => {
  const g = makeGates();
  const r1 = await g.acquire({
    host: "imap.example.com",
    company: "acme-corp",
    account: "ceo@example.com",
    priority: "interactive",
  });
  const r2 = await g.acquire({
    host: "IMAP.other.com",
    company: "acme-corp",
    account: "cto@example.com",
    priority: "interactive",
  });
  const s = g.stats();
  assert.equal(s.enabled, true);
  assert.equal(s.activeGlobal, 2);
  assert.equal(s.activeHostCount, 2);
  assert.equal(s.limits.globalMax, baseCfg.globalMax);
  assert.ok(s.waitMsP50 >= 0);
  assert.ok(s.waitMsP95 >= 0);
  // Contract: stats must be a bounded numeric surface. No secrets, hostnames,
  // email addresses, or company identifiers may appear anywhere in the blob.
  const serialized = JSON.stringify(s);
  assert.equal(serialized.includes("example.com"), false);
  assert.equal(serialized.includes("acme"), false);
  assert.equal(serialized.includes("ceo"), false);
  assert.equal(serialized.includes("cto"), false);
  r1();
  r2();
});

test("host normalization: mixed-case and whitespace count as one host key", async () => {
  const g = makeGates({
    globalMax: 10,
    perHostMax: 1,
    perCompanyMax: 10,
    perAccountMax: 10,
  });
  const r1 = await g.acquire({
    host: "IMAP.Example.COM",
    company: "c",
    account: "a",
    priority: "interactive",
  });
  let resolved = false;
  const p2 = g
    .acquire({
      host: "  imap.example.com  ",
      company: "c",
      account: "b",
      priority: "interactive",
    })
    .then((r) => {
      resolved = true;
      return r;
    });
  await sleep(20);
  // Per-host cap = 1; second acquire must block until first releases,
  // proving both host strings hashed to the same normalized key.
  assert.equal(resolved, false);
  assert.equal(g.stats().activeHostCount, 1);
  r1();
  const r2 = await p2;
  r2();
});

test("release is always called on the success path (activeGlobal returns to 0)", async () => {
  const g = makeGates();
  const r = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  assert.equal(g.stats().activeGlobal, 1);
  r();
  assert.equal(g.stats().activeGlobal, 0);
});

test("timeout path never leaves counters or waiters leaked", async () => {
  const g = makeGates({ globalMax: 1, perAccountMax: 1, interactiveWaitTimeoutMs: 20 });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  await g
    .acquire({ host: "h", company: "c", account: "b", priority: "interactive" })
    .catch(() => {});
  const s = g.stats();
  assert.equal(s.waitingInteractive, 0);
  assert.equal(s.waitingBackground, 0);
  assert.equal(s.activeGlobal, 1); // only the first is still held
  r1();
  assert.equal(g.stats().activeGlobal, 0);
});

test("cancellation path never leaves counters or waiters leaked", async () => {
  const g = makeGates({ globalMax: 1, perAccountMax: 1, interactiveWaitTimeoutMs: 5000 });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
  const ac = new AbortController();
  const p = g
    .acquire({
      host: "h",
      company: "c",
      account: "b",
      priority: "interactive",
      signal: ac.signal,
    })
    .catch(() => {});
  setTimeout(() => ac.abort(), 5);
  await p;
  const s = g.stats();
  assert.equal(s.waitingInteractive, 0);
  assert.equal(s.activeGlobal, 1);
  r1();
});

test("feature flag OFF: acquire never blocks, never rejects, never emits IMAP_BUSY", async () => {
  const g = createImapGates({
    ...baseCfg,
    enabled: false,
    globalMax: 1,
    perAccountMax: 1,
    waitQueueMax: 1,
    interactiveWaitTimeoutMs: 1,
  });
  // Hammer well past every cap. Legacy unlimited path must resolve them all
  // synchronously with no-op releases.
  const N = 50;
  const rs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      g.acquire({
        host: "h",
        company: "c",
        account: `a${i % 3}`,
        priority: i % 2 ? "background" : "interactive",
      }),
    ),
  );
  assert.equal(rs.length, N);
  const s = g.stats();
  assert.equal(s.enabled, false);
  assert.equal(s.admitted, 0); // no accounting when disabled
  assert.equal(s.activeGlobal, 0);
  rs.forEach((r) => r());
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

test("media can never hold both per-account permits (media cap = 1 < account cap)", async () => {
  const g = makeGates({
    globalMax: 10,
    perHostMax: 10,
    perCompanyMax: 10,
    perAccountMax: 2,
  });
  const m1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "media" });
  let m2Resolved = false;
  const m2 = g.acquire({ host: "h", company: "c", account: "a", priority: "media" }).then((r) => {
    m2Resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(m2Resolved, false, "second media op must queue (media cap is 1)");

  // A BODY open for the same account is still admitted immediately: media
  // holds 1 of 2 permits, so the reserved body class must not block.
  const body = await g.acquire({ host: "h", company: "c", account: "a", priority: "body" });
  assert.equal(m2Resolved, false, "body open must not wait behind queued media");

  body();
  m1();
  const m2r = await m2;
  m2r();
  assert.equal(g.stats().activeGlobal, 0);
});

test("BODY jumps ahead of queued media on a shared slot", async () => {
  const g = makeGates({
    globalMax: 1,
    perHostMax: 10,
    perCompanyMax: 10,
    perAccountMax: 2,
    interactiveWaitTimeoutMs: 5000,
    mediaWaitTimeoutMs: 5000,
  });
  // Prime the single global slot with a media op for account a.
  const r0 = await g.acquire({ host: "h", company: "c", account: "a", priority: "media" });

  const order: string[] = [];
  const track = (label: string, priority: "body" | "media" | "background") =>
    g.acquire({ host: "h", company: "c", account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const all = Promise.all([track("media1", "media"), track("body1", "body")]);
  r0();
  await all;
  assert.deepEqual(order, ["body1", "media1"], "a queued media op must never overtake a BODY open");
});

test("media defaults keep every existing gate limit unchanged", () => {
  const c = loadImapGatesConfigFromEnv({});
  assert.equal(c.globalMax, 32);
  assert.equal(c.perHostMax, 12);
  assert.equal(c.perCompanyMax, 4);
  assert.equal(c.perAccountMax, 2);
  assert.equal(c.mediaPerAccountMax, 1);
  assert.equal(c.nonBodyPerAccountMax, 1);
  assert.equal(c.bodyWaitTimeoutMs, 8000);
  assert.equal(c.transferWaitTimeoutMs, 15000);
});

test("stats exposes waitingMedia and the media per-account limit", async () => {
  const g = makeGates({
    globalMax: 1,
    perAccountMax: 2,
    interactiveWaitTimeoutMs: 5000,
    mediaWaitTimeoutMs: 5000,
  });
  const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "media" });
  const p2 = g.acquire({ host: "h", company: "c", account: "a", priority: "media" }).then((r) => r);
  await sleep(20);
  assert.equal(g.stats().waitingMedia, 1);
  assert.equal(g.stats().limits.mediaPerAccountMax, 1);
  assert.equal(g.stats().limits.nonBodyPerAccountMax, 1);
  r1();
  (await p2)();
});
