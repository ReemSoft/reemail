/**
 * MAILMAESTRO — BODY CAPACITY RESERVATION gate tests.
 *
 * Deterministic (no live IMAP) proof of the reservation guarantee at the
 * ADMISSION level:
 *
 *   * per-account TOTAL <= 2 (IMAP_PER_ACCOUNT_MAX)
 *   * per-account NON-BODY (interactive/media/transfer/background) <= 1
 *   * BODY is the reserved, highest-priority class — exempt from the non-body
 *     cap, so one non-body op + one BODY op always run concurrently
 *   * two non-body ops can never both be admitted (background+media,
 *     background+transfer, media+transfer all block the SECOND at admission)
 *   * BODY2 waits only when total capacity is already consumed by BODY work,
 *     and is admitted before queued non-body once a BODY slot frees
 *   * waitQueueMax counts EVERY class (body/interactive/media/transfer/background)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createImapGates,
  loadImapGatesConfigFromEnv,
  type ImapGates,
  type ImapGatesConfig,
  type ImapPriority,
} from "../src/imap-gates.js";

const ACCOUNT_CFG: ImapGatesConfig = {
  enabled: true,
  globalMax: 10,
  perHostMax: 10,
  perCompanyMax: 10,
  perAccountMax: 2,
  waitQueueMax: 50,
  interactiveWaitTimeoutMs: 5000,
  backgroundWaitTimeoutMs: 5000,
};

const makeGates = (overrides: Partial<ImapGatesConfig> = {}): ImapGates =>
  createImapGates({ ...ACCOUNT_CFG, ...overrides });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = { host: "h", company: "c", account: "a" };

test("1. active background -> BODY starts immediately", async () => {
  const g = makeGates();
  const bg = await g.acquire({ ...A, priority: "background" });
  let resolved = false;
  const body = g.acquire({ ...A, priority: "body" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, true, "BODY must not wait behind an active background op");
  assert.equal(g.stats().activeGlobal, 2, "total = 1 non-body + 1 body = 2");
  bg();
  (await body)();
});

test("2. active media -> BODY starts immediately", async () => {
  const g = makeGates();
  const m = await g.acquire({ ...A, priority: "media" });
  let resolved = false;
  const body = g.acquire({ ...A, priority: "body" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, true, "BODY must not wait behind an active media op");
  m();
  (await body)();
});

test("3. active transfer -> BODY starts immediately", async () => {
  const g = makeGates();
  const t = await g.acquire({ ...A, priority: "transfer" });
  let resolved = false;
  const body = g.acquire({ ...A, priority: "body" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, true, "BODY must not wait behind an active transfer op");
  t();
  (await body)();
});

test("4. active background + request media: media waits (non-body slot occupied)", async () => {
  const g = makeGates();
  const bg = await g.acquire({ ...A, priority: "background" });
  let resolved = false;
  const m = g.acquire({ ...A, priority: "media" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, false, "media must queue behind the one non-body slot");
  assert.equal(g.stats().activeGlobal, 1);
  bg();
  const mr = await m;
  mr();
});

test("5. active media + request transfer: transfer waits", async () => {
  const g = makeGates();
  const m = await g.acquire({ ...A, priority: "media" });
  let resolved = false;
  const t = g.acquire({ ...A, priority: "transfer" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, false, "transfer must queue behind the one non-body slot");
  m();
  const tr = await t;
  tr();
});

test("6. active transfer + request background: background waits", async () => {
  const g = makeGates();
  const t = await g.acquire({ ...A, priority: "transfer" });
  let resolved = false;
  const bg = g.acquire({ ...A, priority: "background" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, false, "background must queue behind the one non-body slot");
  t();
  const bgr = await bg;
  bgr();
});

test("7. one active non-body + BODY: total exactly 2, BODY admitted", async () => {
  const g = makeGates();
  const nb = await g.acquire({ ...A, priority: "background" });
  const body = await g.acquire({ ...A, priority: "body" });
  assert.equal(g.stats().activeGlobal, 2, "1 non-body + 1 body = 2 total");
  assert.equal(g.stats().activeHostCount, 1);
  nb();
  body();
});

test("8. BODY + non-body active + BODY2: BODY2 waits only for total capacity; admitted before queued non-body when BODY1 frees", async () => {
  const g = makeGates();
  const b1 = await g.acquire({ ...A, priority: "body" });
  const nb = await g.acquire({ ...A, priority: "media" });
  // account at 2 (body + media). A second body and a second media both queue.
  let b2Resolved = false;
  let nb2Resolved = false;
  const b2 = g.acquire({ ...A, priority: "body" }).then((r) => {
    b2Resolved = true;
    return r;
  });
  const nb2 = g.acquire({ ...A, priority: "media" }).then((r) => {
    nb2Resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(b2Resolved, false, "BODY2 waits only because total capacity is full");
  assert.equal(nb2Resolved, false, "media2 also queues");
  // BODY1 finishes -> BODY2 must be admitted before queued non-body.
  b1();
  await sleep(20);
  assert.equal(b2Resolved, true, "BODY2 admitted once a BODY slot frees");
  assert.equal(nb2Resolved, false, "media2 still queued behind BODY2 + media1");
  // media1 finishes -> media2 may join BODY2 (one non-body slot is free again).
  nb();
  await sleep(20);
  assert.equal(nb2Resolved, true, "media2 joins once the non-body slot frees");
  assert.equal(g.stats().activeGlobal, 2, "still never above the account max");
  (await b2)();
  (await nb2)();
});

test("9. two BODY active: non-body waits", async () => {
  const g = makeGates();
  const b1 = await g.acquire({ ...A, priority: "body" });
  const b2 = await g.acquire({ ...A, priority: "body" });
  assert.equal(g.stats().activeGlobal, 2, "two body ops use both account permits");
  let resolved = false;
  const nb = g.acquire({ ...A, priority: "background" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, false, "non-body must wait when both permits are BODY");
  b1();
  b2();
  const nbr = await nb;
  nbr();
});

test("10. queued BODY outranks queued media/transfer/background", async () => {
  const g = makeGates({ globalMax: 1, perAccountMax: 2 });
  const r0 = await g.acquire({ ...A, priority: "background" });

  const order: string[] = [];
  const track = (label: string, priority: ImapPriority) =>
    g.acquire({ ...A, priority }).then((rel) => {
      order.push(label);
      rel();
    });

  const all = Promise.all([
    track("media", "media"),
    track("transfer", "transfer"),
    track("background", "background"),
    track("body", "body"),
  ]);
  r0();
  await all;
  assert.equal(order[0], "body", "queued BODY is admitted before every queued non-body");
  assert.deepEqual(new Set(order), new Set(["body", "media", "transfer", "background"]));
});

test("11. waitQueueMax counts BODY + media + transfer + background", async () => {
  const g = makeGates({
    globalMax: 1,
    perHostMax: 10,
    perCompanyMax: 10,
    perAccountMax: 10,
    waitQueueMax: 3,
  });
  // Hold the sole global slot.
  const r0 = await g.acquire({ host: "h0", company: "c", account: "z0", priority: "background" });
  // Queue one waiter per class (body, media, transfer, background) = 4 total.
  g.acquire({ ...A, priority: "body" }).catch(() => {});
  g.acquire({ ...A, priority: "media" }).catch(() => {});
  g.acquire({ ...A, priority: "transfer" }).catch(() => {});
  await sleep(20);
  const s = g.stats();
  assert.equal(
    s.waitingBody + s.waitingMedia + s.waitingTransfer + s.waitingBackground,
    3,
    "three waiters fill waitQueueMax=3",
  );
  // The fourth (background) must be rejected as queue-full because EVERY
  // class counts toward the bound.
  const err = await g
    .acquire({ ...A, priority: "background" })
    .then(() => null)
    .catch((e) => e);
  assert.ok(
    err && err.code === "IMAP_BUSY",
    "fourth waiter rejected: waitQueueMax includes all classes",
  );
  r0();
});

test("12. attachment route no longer consumes BODY gate class", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /app\.post\("\/api\/attachment", requireKey, imapGate\("transfer"\)/);
  assert.doesNotMatch(
    index.slice(index.indexOf("/api/attachment"), index.indexOf("/api/attachment") + 80),
    /imapGate\("interactive"\)/,
  );
});

test("13. attachment streaming is preserved (transfer lane, streamed response)", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const att = index.slice(index.indexOf('app.post("/api/attachment"'));
  assert.match(att, /content\.pipe\(res\)/);
  assert.match(att, /downloadAttachment\(/);
});

test("14. CID still automatically loads (media gate + media lane)", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const imap = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  assert.equal((index.match(/"\/api\/message-inline-images"/g) ?? []).length, 1);
  assert.equal((index.match(/imapGate\("media"\)/g) ?? []).length, 3);
  assert.match(imap, /getMailboxesCached\(account, password, "media"\)/);
});

test("15. small CID remains one multi-part FETCH", () => {
  const imap = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const inline = imap.slice(
    imap.indexOf("export async function downloadInlinePartsInMailbox("),
    imap.indexOf("export async function getInlineImagesBatch("),
  );
  assert.equal((inline.match(/fetchOne\(/g) ?? []).length, 1);
  assert.match(inline, /INLINE_IMAGE_ENCODED_MAX_BYTES \+ 1/);
  assert.doesNotMatch(inline, /downloadMany/);
});

test("16. background still downloads zero CID bytes", () => {
  const imap = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const body = imap.slice(
    imap.indexOf("export async function getMessageBody("),
    imap.indexOf("export async function getMessageBodiesBatch("),
  );
  assert.doesNotMatch(body, /toDownload: candidates/);
  const plan = imap.slice(
    imap.indexOf("export function planInlineImagesForOpen("),
    imap.indexOf("export interface TrustedMailboxHint"),
  );
  assert.match(plan, /toDownload: \[\]/);
});

test("17. gate limits remain exactly unchanged in production defaults", () => {
  const c = loadImapGatesConfigFromEnv({});
  assert.equal(c.globalMax, 32);
  assert.equal(c.perHostMax, 12);
  assert.equal(c.perCompanyMax, 4);
  assert.equal(c.perAccountMax, 2);
  assert.equal(c.nonBodyPerAccountMax, 1);
  assert.equal(c.mediaPerAccountMax, 1);
});

test("18. active account count can never exceed 2", async () => {
  const g = makeGates({ globalMax: 100 });
  const b1 = await g.acquire({ ...A, priority: "body" });
  const m = await g.acquire({ ...A, priority: "media" });
  assert.equal(g.stats().activeGlobal, 2, "body + media fill the account");
  // A third op (background) must queue — total capacity is full.
  let resolved = false;
  const bg = g.acquire({ ...A, priority: "background" }).then((r) => {
    resolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(resolved, false, "third op waits: account already at 2");
  assert.equal(g.stats().activeGlobal, 2, "account never exceeds 2 active permits");
  // BODY1 finishes -> total drops to 1 (media only); background is still
  // blocked by the non-body cap until media releases.
  b1();
  await sleep(20);
  assert.equal(resolved, false, "background must wait behind the media non-body slot");
  assert.equal(g.stats().activeGlobal, 1);
  m();
  const bgr = await bg;
  assert.equal(g.stats().activeGlobal, 1, "background finally admitted alone");
  bgr();
  assert.equal(g.stats().activeGlobal, 0);
});

test("19. active non-body count can never exceed 1", async () => {
  const g = makeGates({ globalMax: 100, perAccountMax: 2 });
  const m = await g.acquire({ ...A, priority: "media" });
  assert.equal(g.stats().activeGlobal, 1);
  // transfer must not join the active media op (both non-body).
  let transferResolved = false;
  const t = g.acquire({ ...A, priority: "transfer" }).then((r) => {
    transferResolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(transferResolved, false, "transfer must not join an active media op");
  assert.equal(g.stats().activeGlobal, 1, "only the one non-body op is active");
  // background must not join either.
  let bgResolved = false;
  const bg = g.acquire({ ...A, priority: "background" }).then((r) => {
    bgResolved = true;
    return r;
  });
  await sleep(20);
  assert.equal(bgResolved, false, "background must not join an active media op");
  assert.equal(g.stats().activeGlobal, 1);
  // media finishes -> transfer admitted; background stays queued behind it.
  m();
  const tr = await t;
  assert.equal(bgResolved, false, "background waits behind the admitted transfer");
  assert.equal(g.stats().activeGlobal, 1);
  tr();
  const bgr = await bg;
  bgr();
  assert.equal(g.stats().activeGlobal, 0);
});

test("20. media / transfer cleanup stays wired through lane loops (no leak)", () => {
  const conn = readFileSync(new URL("../src/imap-connection.ts", import.meta.url), "utf8");
  assert.match(
    conn,
    /export type ImapLane = "interactive" \| "media" \| "background" \| "transfer";/,
  );
  assert.match(conn, /for \(const lane of \["interactive", "media", "background", "transfer"\]/);
  assert.match(
    conn,
    /const lanes: ImapLane\[\] = lane \? \[lane\] : \["interactive", "media", "background", "transfer"\]/,
  );
  assert.match(conn, /closeAllImapConnections/);
  assert.match(conn, /maxConnectionsPerAccount: 4/);
});
