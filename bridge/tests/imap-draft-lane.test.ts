/**
 * MAILMAESTRO_DRAFTS_V4 — Draft lane serialization contract.
 *
 * Locks the invariant that the whole Draft pipeline runs serialized on a
 * per-account "draft" lane, so two concurrent saves for DIFFERENT draftIds on
 * the SAME account can never interleave, while the interactive lane stays
 * independent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claimLaneHold } from "../src/imap-connection.js";

test("claimLaneHold serializes: second acquire waits for the first release", async () => {
  const chainRef = { current: Promise.resolve() as Promise<unknown> };
  const events: string[] = [];

  const a = claimLaneHold(chainRef).then((release) => {
    events.push("A-acquired");
    return { release, hold: new Promise<void>((r) => setTimeout(r, 20)) };
  });

  // B must not acquire until A releases.
  const b = claimLaneHold(chainRef).then(() => {
    events.push("B-acquired");
  });

  const { release } = await a;
  assert.deepEqual(events, ["A-acquired"], "B must NOT acquire while A holds the lane");

  release();
  await b;
  assert.deepEqual(events, ["A-acquired", "B-acquired"]);
});

test("claimLaneHold serializes three holders in order", async () => {
  const chainRef = { current: Promise.resolve() as Promise<unknown> };
  const order: number[] = [];
  const first = await claimLaneHold(chainRef);
  const secondP = claimLaneHold(chainRef).then((r) => {
    order.push(2);
    return r;
  });
  const thirdP = claimLaneHold(chainRef).then((r) => {
    order.push(3);
    return r;
  });
  order.push(1);
  first();
  const second = await secondP;
  assert.deepEqual(order, [1, 2], "second runs only after first releases");
  second();
  await thirdP;
  assert.deepEqual(order, [1, 2, 3]);
});

test("production Draft adapter serializes the whole pipeline via acquireAccountClient", () => {
  const drafts = readFileSync(new URL("../src/drafts.ts", import.meta.url), "utf8");
  const conn = readFileSync(new URL("../src/imap-connection.ts", import.meta.url), "utf8");
  // The raw-client primitive must be gone: the client is held only between
  // acquire (connect) and release (logout).
  assert.doesNotMatch(drafts, /getAccountClient/, "raw unsynchronized client access must be removed");
  assert.match(drafts, /acquireAccountClient\(account, password, "draft"\)/);
  assert.match(drafts, /release\(\);/, "logout must release the lane hold");
  assert.match(conn, /entry\.chain/, "acquireAccountClient must serialize on Entry.chain");
  assert.match(conn, /function claimLaneHold/);
});

test("draft lane key is distinct from interactive (draft never queues behind/with interactive)", () => {
  const conn = readFileSync(new URL("../src/imap-connection.ts", import.meta.url), "utf8");
  // keyFor embeds the lane, so draft and interactive get separate entries/connections.
  assert.match(conn, /\$\{lane\}\|/);
  // The draft lane is one of the declared lanes.
  assert.match(conn, /"draft"/);
});
