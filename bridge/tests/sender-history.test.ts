import assert from "node:assert/strict";
import test from "node:test";
import type { ImapFlow } from "imapflow";
import { getSenderMessagesPageInMailbox, type SenderMessagesCursor } from "../src/imap.js";

type MockRecord = { uid: number; from: string; date?: Date };

function mockClient(records: MockRecord[], uidValidity = "77") {
  const calls = { searches: 0, fetches: 0, criteria: [] as unknown[], fetched: [] as number[][] };
  const client = {
    mailbox: { uidValidity },
    options: { auth: { user: "owner@example.com" } },
    async search(criteria: { from?: string; uid?: string }) {
      calls.searches += 1;
      calls.criteria.push(criteria);
      const target = criteria.from?.toLowerCase() ?? "";
      const upper = criteria.uid ? Number(criteria.uid.split(":")[1]) : Number.MAX_SAFE_INTEGER;
      return records
        .filter((record) => record.uid <= upper && record.from.toLowerCase().includes(target))
        .map((record) => record.uid);
    },
    async *fetch(uids: number[]) {
      calls.fetches += 1;
      calls.fetched.push([...uids]);
      for (const uid of [...uids].reverse()) {
        const record = records.find((candidate) => candidate.uid === uid)!;
        yield {
          uid,
          envelope: {
            from: [{ address: record.from }],
            to: [{ address: "owner@example.com" }],
            subject: `Message ${uid}`,
            messageId: `<${uid}@example.com>`,
          },
          internalDate: record.date ?? new Date(1_700_000_000_000 + uid * 1000),
          flags: new Set<string>(),
          bodyStructure: undefined,
        };
      }
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

test("pages all 437 sender matches without a 200-result cap", async () => {
  const records = Array.from({ length: 437 }, (_, index) => ({
    uid: index + 1,
    from: "sender@example.com",
  }));
  const { client, calls } = mockClient(records);
  let cursor: SenderMessagesCursor | undefined;
  const seen: number[] = [];
  let hasMore = true;

  while (hasMore) {
    const page = await getSenderMessagesPageInMailbox(client, "SENDER@example.com", 50, cursor);
    seen.push(...page.messages.map((message) => Number(message.id.split(":")[1])));
    cursor = page.nextCursor ?? undefined;
    hasMore = page.hasMore;
  }

  assert.equal(seen.length, 437);
  assert.deepEqual(
    seen,
    Array.from({ length: 437 }, (_, index) => 437 - index),
  );
  assert.equal(calls.searches, 9);
  assert.equal(calls.fetches, 9);
  assert.ok(calls.fetched.every((uids) => uids.length <= 50));
});

test("uses From-only SEARCH and exact-filters substring matches", async () => {
  const { client, calls } = mockClient([
    { uid: 4, from: "sender@example.com" },
    { uid: 3, from: "other-sender@example.com" },
    { uid: 2, from: "sender@example.com" },
  ]);
  const page = await getSenderMessagesPageInMailbox(client, "sender@example.com", 50);

  assert.deepEqual(
    page.messages.map((message) => message.id),
    ["inbox:4", "inbox:2"],
  );
  assert.deepEqual(calls.criteria[0], { from: "sender@example.com" });
  assert.equal(calls.searches, 1);
  assert.equal(calls.fetches, 1);
});

test("cursor advances through every examined candidate even when none pass exact From", async () => {
  const records = Array.from({ length: 75 }, (_, index) => ({
    uid: index + 1,
    from: index < 25 ? "sender@example.com" : "other-sender@example.com",
  }));
  const { client } = mockClient(records);

  const first = await getSenderMessagesPageInMailbox(client, "sender@example.com", 50);
  assert.equal(first.messages.length, 0);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor?.beforeUid, 26);

  const second = await getSenderMessagesPageInMailbox(
    client,
    "sender@example.com",
    50,
    first.nextCursor!,
  );
  assert.equal(second.messages.length, 25);
  assert.equal(second.hasMore, false);
});

test("UIDVALIDITY mismatch resets the stale UID range", async () => {
  const { client, calls } = mockClient(
    Array.from({ length: 4 }, (_, index) => ({ uid: index + 1, from: "sender@example.com" })),
    "88",
  );
  const page = await getSenderMessagesPageInMailbox(client, "sender@example.com", 2, {
    beforeUid: 2,
    uidValidity: "77",
  });

  assert.equal(page.cursorReset, true);
  assert.deepEqual(calls.criteria[0], { from: "sender@example.com" });
  assert.deepEqual(
    page.messages.map((message) => message.id),
    ["inbox:4", "inbox:3"],
  );
  assert.equal(page.nextCursor?.uidValidity, "88");
});

test("final empty search is authoritative and does not FETCH", async () => {
  const { client, calls } = mockClient([]);
  const page = await getSenderMessagesPageInMailbox(client, "sender@example.com", 50);
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(calls.searches, 1);
  assert.equal(calls.fetches, 0);
});
