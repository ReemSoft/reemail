/**
 * Integration test: imapGate middleware behavior on client abort while
 * waiting for a permit. Boots a minimal Express app on a random port,
 * saturates the limiter, sends a second request that must wait, then
 * aborts the HTTP client mid-wait. Asserts:
 *   * waiting counter returns to 0
 *   * cancelled counter increments by exactly 1
 *   * downstream handler (`next`) is NEVER invoked for the aborted req
 *   * no permit leak (activeGlobal stays at 1 — only the holder)
 *   * no listener/timer leak (waiter drained, permit released on release)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createImapGates } from "../src/imap-gates.js";
import { createImapGateMiddleware } from "../src/imap-gate-middleware.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootApp() {
  const gates = createImapGates({
    enabled: true,
    globalMax: 1,
    perHostMax: 10,
    perCompanyMax: 10,
    perAccountMax: 10,
    waitQueueMax: 20,
    interactiveWaitTimeoutMs: 5000,
    backgroundWaitTimeoutMs: 5000,
  });
  const app = express();
  app.use(express.json());
  let downstreamCalls = 0;
  // Handler releases permit only when signalled via a shared promise so
  // the test can hold the sole slot while the second request queues.
  let holderRelease: (() => void) | null = null;
  const holderReleased = new Promise<void>((r) => (holderRelease = r));
  app.post(
    "/hold",
    createImapGateMiddleware(gates, "interactive"),
    async (_req, res) => {
      downstreamCalls++;
      await holderReleased;
      res.json({ ok: true });
    },
  );
  app.post(
    "/wait",
    createImapGateMiddleware(gates, "interactive"),
    async (_req, res) => {
      downstreamCalls++;
      res.json({ ok: true });
    },
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    gates,
    stop: () =>
      new Promise<void>((r) => {
        holderRelease?.();
        server.close(() => r());
      }),
    releaseHolder: () => holderRelease?.(),
    downstream: () => downstreamCalls,
  };
}

test("client abort while waiting for permit: waiter drained, cancelled++, next() never called", async () => {
  const { port, gates, stop, releaseHolder, downstream } = await bootApp();
  try {
    const body = JSON.stringify({
      account: { imap_host: "h", company_id: "c", email_address: "a@x" },
    });
    // 1) Saturate the single global slot.
    const holderPromise = fetch(`http://127.0.0.1:${port}/hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // Give the holder time to acquire the permit.
    for (let i = 0; i < 50; i++) {
      if (gates.stats().activeGlobal === 1) break;
      await sleep(10);
    }
    assert.equal(gates.stats().activeGlobal, 1);

    // 2) Second request must queue.
    const ac = new AbortController();
    const waiterErr = fetch(`http://127.0.0.1:${port}/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ac.signal,
    }).catch((e) => e);
    for (let i = 0; i < 50; i++) {
      if (gates.stats().waitingInteractive === 1) break;
      await sleep(10);
    }
    assert.equal(gates.stats().waitingInteractive, 1);

    // 3) Client aborts mid-wait.
    ac.abort();
    const err = await waiterErr;
    assert.ok(err instanceof Error, "aborted fetch rejects");

    // Give the server event loop a tick to process the socket close.
    for (let i = 0; i < 50; i++) {
      if (gates.stats().waitingInteractive === 0 && gates.stats().cancelled >= 1) break;
      await sleep(10);
    }

    const s = gates.stats();
    assert.equal(s.waitingInteractive, 0, "waiter drained");
    assert.equal(s.cancelled, 1, "cancelled counter incremented by exactly 1");
    assert.equal(s.activeGlobal, 1, "no permit leak — only the holder is still in-flight");
    // Only the holder handler ran. The aborted /wait must NOT have called next().
    assert.equal(downstream(), 1, "downstream handler never invoked for the aborted request");

    // 4) Release the holder, everything should return to zero cleanly.
    releaseHolder();
    await holderPromise.catch(() => {});
    for (let i = 0; i < 50; i++) {
      if (gates.stats().activeGlobal === 0) break;
      await sleep(10);
    }
    assert.equal(gates.stats().activeGlobal, 0, "permit released cleanly after holder finishes");
  } finally {
    await stop();
  }
});

test("waiter listeners are removed after admission (no ghost abort on response close)", async () => {
  // If the middleware forgot to detach req.aborted / req.close after
  // admission, a normal response close would fire the abort handler and
  // could double-release or corrupt counters. We verify by admitting,
  // finishing the response, then confirming counters are pristine.
  const gates = createImapGates({
    enabled: true,
    globalMax: 2,
    perHostMax: 10,
    perCompanyMax: 10,
    perAccountMax: 10,
    waitQueueMax: 5,
    interactiveWaitTimeoutMs: 2000,
    backgroundWaitTimeoutMs: 2000,
  });
  const app = express();
  app.use(express.json());
  app.post("/ok", createImapGateMiddleware(gates, "interactive"), (_req, res) =>
    res.json({ ok: true }),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    const body = JSON.stringify({
      account: { imap_host: "h", company_id: "c", email_address: "a@x" },
    });
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/ok`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(r.status, 200);
    }
    // A single tick is enough for res.finish handlers to fire.
    await sleep(20);
    const s = gates.stats();
    assert.equal(s.activeGlobal, 0);
    assert.equal(s.cancelled, 0, "no spurious cancellation on normal response close");
    assert.equal(s.admitted, 5);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
