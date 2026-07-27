/**
 * MAILMAESTRO_IMAP_LIMITER_R3 — imap-gates unit tests.
 *
 * These tests exercise the limiter in isolation (no live IMAP). They cover:
 *   * disabled-flag no-op
 *   * per-key caps (global, host, company, account)
 *   * FIFO ordering inside a priority queue
 *   * weighted fairness (interactive priority, background never starved)
 *   * overflow rejection (queue-full)
 *   * wait timeout rejection
 *   * AbortSignal cancellation
 *   * release idempotency
 *   * metrics stability under load
 */

import { describe, it, expect, beforeEach } from "vitest";
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

function makeGates(overrides: Partial<ImapGatesConfig> = {}): ImapGates {
  return createImapGates({ ...baseCfg, ...overrides });
}

const K = (i: number, opts: Partial<{ host: string; company: string }> = {}) => ({
  host: opts.host ?? "imap.example.com",
  company: opts.company ?? "co-a",
  account: `user${i}@example.com`,
  priority: "interactive" as const,
});

describe("imap-gates: feature flag", () => {
  it("disabled flag returns a no-op release immediately and never blocks", async () => {
    const g = createImapGates({ ...baseCfg, enabled: false, globalMax: 1, perAccountMax: 1 });
    const releases = await Promise.all([
      g.acquire(K(1)),
      g.acquire(K(1)), // Same account: would block if enabled — must not here.
      g.acquire(K(2)),
    ]);
    expect(releases).toHaveLength(3);
    releases.forEach((r) => r());
    expect(g.stats().activeGlobal).toBe(0);
  });
});

describe("imap-gates: per-key caps", () => {
  let g: ImapGates;
  beforeEach(() => { g = makeGates(); });

  it("blocks a second acquire on the same account until release", async () => {
    const r1 = await g.acquire(K(1));
    let resolved = false;
    const p2 = g.acquire(K(1)).then((r) => { resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    r1();
    const r2 = await p2;
    expect(resolved).toBe(true);
    r2();
  });

  it("respects the per-host cap independent of per-account", async () => {
    const g2 = makeGates({ perHostMax: 2, perAccountMax: 1, perCompanyMax: 10, globalMax: 10 });
    const r1 = await g2.acquire(K(1));
    const r2 = await g2.acquire(K(2));
    // Third distinct account on same host must queue on perHostMax.
    let resolved = false;
    const p3 = g2.acquire(K(3)).then((r) => { resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    r1();
    const r3 = await p3;
    expect(resolved).toBe(true);
    r2(); r3();
  });

  it("respects the per-company cap independent of host", async () => {
    const g2 = makeGates({ perCompanyMax: 1, perAccountMax: 5, perHostMax: 10, globalMax: 10 });
    const r1 = await g2.acquire({ ...K(1, { host: "a.com" }), account: "x@a" });
    let resolved = false;
    const p2 = g2.acquire({ ...K(2, { host: "b.com" }), account: "y@b" }).then((r) => { resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    r1();
    const r2 = await p2;
    expect(resolved).toBe(true);
    r2();
  });

  it("respects the global cap across everything", async () => {
    const g2 = makeGates({ globalMax: 2, perHostMax: 10, perCompanyMax: 10, perAccountMax: 10 });
    const r1 = await g2.acquire({ host: "a", company: "1", account: "a", priority: "interactive" });
    const r2 = await g2.acquire({ host: "b", company: "2", account: "b", priority: "interactive" });
    let resolved = false;
    const p3 = g2.acquire({ host: "c", company: "3", account: "c", priority: "interactive" })
      .then((r) => { resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    r1();
    const r3 = await p3;
    expect(resolved).toBe(true);
    r2(); r3();
  });
});

describe("imap-gates: fairness & priority", () => {
  it("prefers interactive over background but never starves background", async () => {
    const g = makeGates({ globalMax: 1, perHostMax: 1, perCompanyMax: 1, perAccountMax: 1 });
    const r0 = await g.acquire({ host: "h", company: "c", account: "a0", priority: "interactive" });

    // Queue: background first (older), then a burst of interactive.
    const order: string[] = [];
    const bg = g.acquire({ host: "h", company: "c", account: "bg", priority: "background" })
      .then((r) => { order.push("bg"); return r; });
    const i1 = g.acquire({ host: "h", company: "c", account: "i1", priority: "interactive" })
      .then((r) => { order.push("i1"); return r; });
    const i2 = g.acquire({ host: "h", company: "c", account: "i2", priority: "interactive" })
      .then((r) => { order.push("i2"); return r; });
    const i3 = g.acquire({ host: "h", company: "c", account: "i3", priority: "interactive" })
      .then((r) => { order.push("i3"); return r; });
    const i4 = g.acquire({ host: "h", company: "c", account: "i4", priority: "interactive" })
      .then((r) => { order.push("i4"); return r; });

    // Release each one and collect the admission order.
    r0();
    const releases = [];
    for (const p of [bg, i1, i2, i3, i4]) {
      const rel = await p;
      releases.push(rel);
      rel();
    }
    // Interactive first, but background must not be last — fairness kicks in
    // after 3 consecutive interactive admissions.
    expect(order[0]).toBe("i1");
    expect(order).toContain("bg");
    const bgIdx = order.indexOf("bg");
    expect(bgIdx).toBeLessThanOrEqual(4);
    // After 3 interactive admits, next should be bg.
    expect(bgIdx).toBe(4 - 1 + 1 - 1); // 3
    releases.forEach((r) => r());
  });
});

describe("imap-gates: overflow / timeout / cancellation", () => {
  it("rejects with IMAP_BUSY when wait queue is full", async () => {
    const g = makeGates({ globalMax: 1, perAccountMax: 1, perCompanyMax: 10, perHostMax: 10, waitQueueMax: 2 });
    const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
    const p1 = g.acquire({ host: "h", company: "c", account: "b", priority: "interactive" });
    const p2 = g.acquire({ host: "h", company: "c", account: "c", priority: "interactive" });
    await expect(
      g.acquire({ host: "h", company: "c", account: "d", priority: "interactive" }),
    ).rejects.toBeInstanceOf(ImapBusyError);
    expect(g.stats().rejected).toBe(1);
    r1();
    (await p1)();
    (await p2)();
  });

  it("rejects with IMAP_BUSY after wait timeout", async () => {
    const g = makeGates({ globalMax: 1, perAccountMax: 1, interactiveWaitTimeoutMs: 40 });
    const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
    const err = await g
      .acquire({ host: "h", company: "c", account: "b", priority: "interactive" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImapBusyError);
    expect((err as ImapBusyError).reason).toBe("timeout");
    expect(g.stats().timedOut).toBe(1);
    r1();
  });

  it("rejects with IMAP_BUSY when signal aborts while waiting", async () => {
    const g = makeGates({ globalMax: 1, perAccountMax: 1, interactiveWaitTimeoutMs: 2000 });
    const r1 = await g.acquire({ host: "h", company: "c", account: "a", priority: "interactive" });
    const ac = new AbortController();
    const p = g.acquire({
      host: "h", company: "c", account: "b", priority: "interactive", signal: ac.signal,
    }).catch((e) => e);
    setTimeout(() => ac.abort(), 10);
    const err = await p;
    expect(err).toBeInstanceOf(ImapBusyError);
    expect((err as ImapBusyError).reason).toBe("cancelled");
    expect(g.stats().cancelled).toBe(1);
    r1();
  });

  it("release is idempotent", async () => {
    const g = makeGates();
    const r = await g.acquire(K(1));
    r(); r(); r();
    expect(g.stats().activeGlobal).toBe(0);
  });
});

describe("imap-gates: metrics", () => {
  it("exposes bounded stats with sane shape", async () => {
    const g = makeGates();
    const r1 = await g.acquire(K(1));
    const r2 = await g.acquire(K(2));
    const s = g.stats();
    expect(s.enabled).toBe(true);
    expect(s.activeGlobal).toBe(2);
    expect(Object.keys(s.activeByHost)).toEqual(["imap.example.com"]);
    expect(s.activeByHost["imap.example.com"]).toBe(2);
    expect(s.limits.globalMax).toBe(baseCfg.globalMax);
    expect(s.waitMsP50).toBeGreaterThanOrEqual(0);
    expect(s.waitMsP95).toBeGreaterThanOrEqual(0);
    r1(); r2();
  });
});

describe("imap-gates: env loader", () => {
  it("defaults enabled=false and applies documented defaults", () => {
    const c = loadImapGatesConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.globalMax).toBe(32);
    expect(c.perHostMax).toBe(12);
    expect(c.perCompanyMax).toBe(4);
    expect(c.perAccountMax).toBe(2);
    expect(c.waitQueueMax).toBe(200);
  });
  it("parses truthy IMAP_GATES_ENABLED variants", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      expect(loadImapGatesConfigFromEnv({ IMAP_GATES_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", ""]) {
      expect(loadImapGatesConfigFromEnv({ IMAP_GATES_ENABLED: v }).enabled).toBe(false);
    }
  });
  it("coerces numeric overrides and rejects invalid values", () => {
    const c = loadImapGatesConfigFromEnv({
      IMAP_GLOBAL_MAX: "16",
      IMAP_PER_HOST_MAX: "abc", // invalid → default
    });
    expect(c.globalMax).toBe(16);
    expect(c.perHostMax).toBe(12);
  });
});
