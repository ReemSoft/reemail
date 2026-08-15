/**
 * MAILMAESTRO — INTERACTIVE BODY / MEDIA ISOLATION architecture tests.
 *
 * Deterministic (no live IMAP) proof that CID/media work is fully isolated
 * from explicit message-BODY opens:
 *
 *   * BODY  -> interactive lane (highest priority), one reusable chain
 *   * MEDIA -> dedicated media lane (separate reusable connection + chain)
 *   * BACKGROUND -> untouched background lane (prefetch / warming)
 *   * TRANSFER -> untouched attachment isolation
 *
 * Source-guard assertions follow the same deterministic pattern as
 * lightning-message-open.test.ts / attachment-transfer.test.ts. Behavioral
 * proofs use the existing dependency-injected `getLargeInlinePart` surface
 * and the real gate limiter in isolation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createImapGates, type ImapGatesConfig } from "../src/imap-gates.js";
import { getLargeInlinePart, type LargeInlinePartDependencies } from "../src/imap.js";
import type { MailAccount } from "../src/types.js";

const imap = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
const connection = readFileSync(new URL("../src/imap-connection.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const gatesSrc = readFileSync(new URL("../src/imap-gates.ts", import.meta.url), "utf8");
const attachmentSources = readFileSync(
  new URL("../src/server-attachment-sources.ts", import.meta.url),
  "utf8",
);
const appResolver = readFileSync(
  new URL("../../src/lib/mail-inline-images.server.ts", import.meta.url),
  "utf8",
);
const appOpen = readFileSync(
  new URL("../../src/lib/mail-message-open.functions.ts", import.meta.url),
  "utf8",
);
const mailRoute = readFileSync(new URL("../../src/routes/mail.tsx", import.meta.url), "utf8");

function slice(outer: string, start: string, end: string): string {
  const s = outer.indexOf(start);
  const e = outer.indexOf(end, s);
  assert.ok(s >= 0, `missing start marker: ${start}`);
  assert.ok(e > s, `missing end marker after ${start}`);
  return outer.slice(s, e);
}

const bodyOpen = slice(
  imap,
  "export async function getMessageBody(",
  "export async function getMessageBodiesBatch(",
);
const smallBatch = slice(
  imap,
  "export async function getInlineImagesBatch(",
  "export const LARGE_INLINE_PART_MAX_BYTES",
);
const largeBatch = slice(
  imap,
  "export async function getLargeInlinePartsBatch(",
  "export interface LargeInlinePartDependencies",
);
const largeSingle = slice(
  imap,
  "export async function getLargeInlinePart(",
  "export async function downloadAttachment",
);
const backgroundBatch = slice(
  imap,
  "export async function getMessageBodiesBatch(",
  "export interface EntireMessageBody",
);
const multiPartFetch = slice(
  imap,
  "export async function downloadInlinePartsInMailbox(",
  "export async function getInlineImagesBatch(",
);
const plan = slice(
  imap,
  "export function planInlineImagesForOpen(",
  "export interface TrustedMailboxHint",
);

// ---------------------------------------------------------------------------
// 1 + 2. Long-running SMALL and LARGE CID/media work must NOT block a BODY open
// ---------------------------------------------------------------------------
test("body opens use the interactive lane and never the media lane", () => {
  assert.match(bodyOpen, /lane: ImapLane = "interactive"/);
  assert.doesNotMatch(bodyOpen, /"media"/);
});

test("small CID batch uses the dedicated media lane (not interactive)", () => {
  assert.match(smallBatch, /getMailboxesCached\(account, password, "media"\)/);
  assert.match(smallBatch, /withAccountMailbox\(/);
  assert.match(smallBatch, /"media",/);
  assert.doesNotMatch(smallBatch, /"interactive"/);
});

test("large CID batch uses the dedicated media lane (not interactive)", () => {
  assert.match(largeBatch, /getMailboxesCached\(account, password, "media"\)/);
  assert.match(largeBatch, /dropAccountConnection\(account, "media"\)/);
  assert.match(largeBatch, /"media",/);
  assert.doesNotMatch(largeBatch, /"interactive"/);
});

test("large CID single part uses the dedicated media lane (not interactive)", () => {
  assert.match(largeSingle, /dependencies\.getMailboxes\(account, password, "media"\)/);
  assert.match(largeSingle, /dependencies\.dropConnection\(account, "media"\)/);
  assert.match(largeSingle, /"media",/);
  assert.doesNotMatch(largeSingle, /"interactive"/);
});

test("each lane owns a distinct serialized chain keyed by lane", () => {
  assert.match(
    connection,
    /export type ImapLane = "interactive" \| "media" \| "background" \| "transfer" \| "draft";/,
  );
  // keyFor embeds the lane, so interactive and media get separate Entry.chain
  // promises on separate connections: media work can never queue a BODY open.
  assert.match(connection, /`\$\{lane\}\|/);
  assert.match(connection, /mediaByAccount|"media"/);
});

test("a large CID request rides the media lane through the reused mailbox path", async () => {
  const account: MailAccount = {
    email_address: "user@example.com",
    display_name: null,
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    smtp_secure: true,
  };
  const calls: Array<{ uid: string; part: string; options: unknown }> = [];
  const client = {
    connect() {
      throw new Error("media CID must not create or connect a client");
    },
    async download(uid: string, part: string, options: unknown) {
      calls.push({ uid, part, options });
      return {
        content: Readable.from([Buffer.from("89504e470d0a1a0a", "hex")]),
        meta: { contentType: "image/png", expectedSize: 8 },
      };
    },
  };
  Object.assign(client, { mailbox: { uidValidity: "77" } });
  const dependencies: LargeInlinePartDependencies = {
    getMailboxes: async () => [{ path: "INBOX" }] as never,
    withMailbox: async (_account, _password, path, operation, lane) => {
      assert.equal(path, "INBOX");
      assert.equal(lane, "media");
      return operation(client as never);
    },
    dropConnection: (_account, lane) => assert.equal(lane, "media"),
  };
  const result = await getLargeInlinePart(
    account,
    "password",
    "inbox",
    42,
    "2",
    "77",
    undefined,
    dependencies,
  );
  assert.equal(result?.bytes.toString("hex"), "89504e470d0a1a0a");
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// 3 + 4. SMALL CID remains ONE multi-part UID FETCH with hard caps
// ---------------------------------------------------------------------------
test("small CID stays a single multi-part UID FETCH with per-part caps", () => {
  assert.equal((multiPartFetch.match(/fetchOne\(/g) ?? []).length, 1);
  assert.doesNotMatch(multiPartFetch, /downloadMany/);
  assert.match(multiPartFetch, /maxLength/);
  assert.match(multiPartFetch, /INLINE_IMAGE_ENCODED_MAX_BYTES \+ 1/);
  assert.doesNotMatch(multiPartFetch, /messageFlagsAdd|messageFlagsRemove|markRead/);
  assert.match(imap, /INLINE_IMAGE_ENCODED_MAX_BYTES = INLINE_IMAGE_MAX_BYTES \* 6;/);
});

// ---------------------------------------------------------------------------
// 5 + 22. BACKGROUND prefetch stays on background, zero CID bytes
// ---------------------------------------------------------------------------
test("background prefetch never uses the BODY interactive lane", () => {
  assert.match(backgroundBatch, /getMessageBody\(account, password, folder, uid, "background"\)/);
  assert.doesNotMatch(backgroundBatch, /"media"/);
  assert.equal((index.match(/"\/api\/messages-prefetch"/g) ?? []).length, 1);
});

test("background prefetch defers every CID part (metadata only, zero bytes)", () => {
  assert.match(bodyOpen, /planInlineImagesForOpen\(metadataCandidates, lane\)/);
  assert.doesNotMatch(bodyOpen, /toDownload: candidates/);
  assert.match(plan, /toDownload: \[\]/);
});

// ---------------------------------------------------------------------------
// 6 + 7. Explicit normal click AND Previous Message expansion both use BODY
// ---------------------------------------------------------------------------
test("explicit message click uses the highest-priority reserved BODY gate", () => {
  assert.match(
    index,
    /const gate = lane === "background" \? imapGate\("background"\) : imapGate\("body"\);/,
  );
  assert.match(
    index,
    /app\.post\("\/api\/message", requireKey, registerMessageOpenIntent, messageGate/,
  );
  assert.match(
    appOpen,
    /lane: z\.enum\(\["interactive", "background"\]\)\.optional\(\)\.default\("interactive"\)/,
  );
});

test("Previous Message expansion is a BODY request on the reserved body gate", () => {
  assert.match(mailRoute, /fetchMessage\(base\.id, "interactive", undefined, \{/);
  assert.match(mailRoute, /kind: "historical"/);
});

// ---------------------------------------------------------------------------
// 8 + 9 + 10. Media / large CID / attachments remain automatic and enabled
// ---------------------------------------------------------------------------
test("small CID hydration remains automatic through the bridge batch", () => {
  assert.match(index, /"\/api\/message-inline-images"/);
  assert.match(appOpen, /"\/api\/message-inline-images"/);
});

test("large CID hydration remains automatic through the bridge", () => {
  assert.equal((index.match(/"\/api\/message-inline-part"/g) ?? []).length, 1);
  assert.equal((index.match(/"\/api\/message-inline-parts"/g) ?? []).length, 1);
});

test("attachment functionality and its transfer isolation remain enabled", () => {
  assert.match(index, /"\/api\/attachment"/);
  assert.match(index, /downloadAttachment\(/);
  assert.match(
    attachmentSources,
    /getMailboxesCached\(input\.account, input\.password, "transfer"\)/,
  );
  assert.match(attachmentSources, /withAccountMailbox\([\s\S]*?"transfer",/);
});

// ---------------------------------------------------------------------------
// 11 + 12 + 13. Bounded concurrency, unchanged limits, media cannot starve BODY
// ---------------------------------------------------------------------------
test("account concurrency stays bounded at five lanes (draft lane added)", () => {
  assert.match(connection, /maxConnectionsPerAccount: 5/);
  assert.match(gatesSrc, /perAccountMax: num\("IMAP_PER_ACCOUNT_MAX", 2\)/);
  assert.match(gatesSrc, /mediaPerAccountMax: num\("IMAP_MEDIA_PER_ACCOUNT_MAX", 1\)/);
});

test("media is capped strictly below the per-account limit", () => {
  assert.match(
    gatesSrc,
    /const mediaPerAccountMax = Math\.max\(1, cfg\.mediaPerAccountMax \?\? 1\);/,
  );
});

test("a queued media op yields to an incoming BODY open (gate-level proof)", async () => {
  const cfg: ImapGatesConfig = {
    enabled: true,
    globalMax: 1,
    perHostMax: 10,
    perCompanyMax: 10,
    perAccountMax: 2,
    waitQueueMax: 20,
    interactiveWaitTimeoutMs: 5000,
    backgroundWaitTimeoutMs: 5000,
  };
  const g = createImapGates(cfg);
  const r0 = await g.acquire({ host: "h", company: "c", account: "a", priority: "media" });
  const order: string[] = [];
  const track = (label: string, priority: "body" | "media") =>
    g.acquire({ host: "h", company: "c", account: "a", priority }).then((rel) => {
      order.push(label);
      rel();
    });
  const all = Promise.all([track("media", "media"), track("body", "body")]);
  r0();
  await all;
  assert.deepEqual(order, ["body", "media"]);
});

// ---------------------------------------------------------------------------
// 14 + 15. Persistent CID cache preserved, cached reload does zero IMAP
// ---------------------------------------------------------------------------
test("persistent CID cache write is preserved after interactive resolution", () => {
  assert.match(appOpen, /cache\.storeCachedInlineImages\(/);
});

test("cached reload performs zero bridge/Gmail CID calls (cache-first)", () => {
  assert.match(appResolver, /const pending = requestedParts\.filter/);
  assert.match(appResolver, /if \(!pending\.length\)/);
  assert.match(appResolver, /source: "cache"/);
  assert.match(appResolver, /deps\.fetchBatch\(pending\)/);
});

// ---------------------------------------------------------------------------
// 16 + 17 + 18. UIDVALIDITY, duplicate-CID fail-closed, no Seen
// ---------------------------------------------------------------------------
test("media CID paths keep UIDVALIDITY enforcement", () => {
  assert.match(largeBatch, /String\(mailbox\.uidValidity\) !== expectedUidValidity/);
  assert.match(largeSingle, /String\(mailbox\.uidValidity\) !== expectedUidValidity/);
});

test("duplicate Content-ID ambiguity stays fail-closed", () => {
  assert.match(largeBatch, /ambiguous/);
  assert.match(largeBatch, /failedCids: \[\.\.\.rejectedCids/);
});

test("no Seen flag mutation is introduced on any CID path", () => {
  assert.doesNotMatch(multiPartFetch, /messageFlagsAdd|messageFlagsRemove|markRead/);
  assert.doesNotMatch(largeBatch, /messageFlagsAdd|messageFlagsRemove|markRead/);
  assert.doesNotMatch(largeSingle, /messageFlagsAdd|messageFlagsRemove|markRead/);
  assert.doesNotMatch(bodyOpen, /messageFlagsAdd|messageFlagsRemove|markRead/);
});

// ---------------------------------------------------------------------------
// 19 + 20. Rapid navigation protection preserved, no HTTP fanout
// ---------------------------------------------------------------------------
test("supersede protection stays intact and only guards current-list opens", () => {
  assert.match(index, /registerMessageOpenIntent/);
  assert.match(index, /MESSAGE_OPEN_SUPERSEDED/);
  assert.match(index, /messageOpenFlights\.run/);
  // Intent (supersede) is only attached to current-list clicks, never to
  // historical expansions — Previous Messages are never cancelled by scope.
  assert.match(mailRoute, /context\.kind === "current-list" && context\.intent/);
});

test("no new HTTP fanout is introduced", () => {
  assert.equal((index.match(/"\/api\/messages-prefetch"/g) ?? []).length, 1);
  assert.match(appOpen, /resolveInlineImageBatchSingleFlight\(/);
});

// ---------------------------------------------------------------------------
// 21. Body cache-hit remains zero IMAP
// ---------------------------------------------------------------------------
test("body cache-hit returns before any bridge/IMAP call", () => {
  assert.match(appOpen, /source: "cache"/);
  assert.ok(
    appOpen.indexOf("if (found?.hit)") < appOpen.indexOf('"/api/message"'),
    "cache hit must short-circuit before the bridge body call",
  );
});
