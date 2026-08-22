import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UidValidityMismatchError,
  assertExpectedUidValidity,
  executePermanentDelete,
  type PermanentDeleteImapClient,
} from "../src/imap.js";

test("UIDVALIDITY helper accepts only the currently-open mailbox generation", () => {
  assert.doesNotThrow(() =>
    assertExpectedUidValidity({ mailbox: { uidValidity: 77 } }, "77"),
  );
  assert.throws(
    () => assertExpectedUidValidity({ mailbox: { uidValidity: 78 } }, "77"),
    UidValidityMismatchError,
  );
  assert.throws(
    () => assertExpectedUidValidity({ mailbox: {} }, "77"),
    UidValidityMismatchError,
  );
});

test("permanent delete mismatch performs zero UID delete and still releases the lock", async () => {
  let deletes = 0;
  let releases = 0;
  const client: PermanentDeleteImapClient = {
    mailbox: { uidValidity: 200 },
    async getMailboxLock() {
      return { release: () => { releases += 1; } };
    },
    async messageDelete() {
      deletes += 1;
      return true;
    },
  };

  await assert.rejects(
    () => executePermanentDelete(client, "Trash", 42, "100"),
    UidValidityMismatchError,
  );
  assert.equal(deletes, 0);
  assert.equal(releases, 1);
});

test("all Bridge UID mutations fence after mailbox lock and before mutation", () => {
  const src = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");

  const mark = src.slice(src.indexOf("export async function markRead"), src.indexOf("export async function starMessage"));
  assert.ok(mark.indexOf("getMailboxLock") < mark.indexOf("assertExpectedUidValidity"));
  assert.ok(mark.indexOf("assertExpectedUidValidity") < mark.indexOf("messageFlagsAdd"));

  const star = src.slice(src.indexOf("export async function starMessage"), src.indexOf("export interface MoveResult"));
  assert.ok(star.indexOf("getMailboxLock") < star.indexOf("assertExpectedUidValidity"));
  assert.ok(star.indexOf("assertExpectedUidValidity") < star.indexOf("messageFlagsAdd"));

  const move = src.slice(src.indexOf("export async function moveMessage"), src.indexOf("export function parseMoveResponse"));
  assert.ok(move.indexOf("getMailboxLock") < move.indexOf("assertExpectedUidValidity"));
  assert.ok(move.indexOf("assertExpectedUidValidity") < move.indexOf("messageMove"));

  const del = src.slice(src.indexOf("export async function executePermanentDelete"), src.indexOf("export async function permanentDeleteMessage"));
  assert.ok(del.indexOf("getMailboxLock") < del.indexOf("assertExpectedUidValidity"));
  assert.ok(del.indexOf("assertExpectedUidValidity") < del.indexOf("messageDelete"));
});

test("Bridge mutation routes require and forward expectedUidValidity", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /MutationMessagePayloadSchema = MessagePayloadSchema\.extend\([\s\S]*expectedUidValidity/);
  for (const route of ["/api/mark-read", "/api/star", "/api/move", "/api/delete"]) {
    const start = src.indexOf(`app.post("${route}"`);
    assert.ok(start >= 0, `missing route ${route}`);
    const next = src.indexOf("\napp.post(", start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    assert.match(body, /expectedUidValidity/);
    assert.match(body, /UIDVALIDITY_MISMATCH/);
  }
});

test("provider list/search rows expose UIDVALIDITY with zero extra IMAP operation", () => {
  const src = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function messageFromFetch");
  const end = src.indexOf("function accountEmail", start);
  const body = src.slice(start, end);
  assert.match(body, /parsed\.uidValidity = String\(mailbox\.uidValidity\)/);
  assert.ok(
    body.indexOf("parsed.uidValidity = String(mailbox.uidValidity)") <
      body.indexOf('if (folder === "drafts" && msg.headers)'),
  );
});
