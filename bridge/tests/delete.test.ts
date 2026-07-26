// Bridge permanent-delete tests (Blocker 1 verification).
//
// Two layers proven here:
//   1) Pure routing: `decideDeleteMode` — trash→"permanent", others→"trash".
//   2) IMAP behavior: `executePermanentDelete` calls `messageDelete` exactly
//      once, NEVER calls `messageMove`, and always releases the mailbox lock
//      even when messageDelete returns false or throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideDeleteMode,
  executePermanentDelete,
  type PermanentDeleteImapClient,
} from "../src/imap.js";
import type { MailFolder } from "../src/types.js";

test("decideDeleteMode: trash → permanent", () => {
  assert.equal(decideDeleteMode("trash"), "permanent");
});

test("decideDeleteMode: non-trash → trash (move)", () => {
  const others: MailFolder[] = [
    "inbox",
    "starred",
    "sent",
    "drafts",
    "spam",
    "archive",
    "all",
  ];
  for (const f of others) {
    assert.equal(decideDeleteMode(f), "trash", `folder=${f}`);
  }
});

interface Recorder {
  lockAcquired: number;
  lockReleased: number;
  messageDelete: Array<{ query: unknown; options: unknown }>;
  messageMove: Array<unknown>;
}
function makeFakeClient(
  behavior: {
    messageDeleteReturns?: boolean;
    messageDeleteThrows?: Error;
  } = {},
): { client: PermanentDeleteImapClient & { messageMove: (...a: any[]) => Promise<any> }; rec: Recorder } {
  const rec: Recorder = {
    lockAcquired: 0,
    lockReleased: 0,
    messageDelete: [],
    messageMove: [],
  };
  const client = {
    async getMailboxLock(_path: string) {
      rec.lockAcquired++;
      return {
        release: () => {
          rec.lockReleased++;
        },
      };
    },
    async messageDelete(query: unknown, options: { uid: true }) {
      rec.messageDelete.push({ query, options });
      if (behavior.messageDeleteThrows) throw behavior.messageDeleteThrows;
      return behavior.messageDeleteReturns ?? true;
    },
    async messageMove(...args: any[]) {
      rec.messageMove.push(args);
      return true;
    },
  };
  return { client, rec };
}

test("executePermanentDelete: messageDelete=1, messageMove=0, lock released", async () => {
  const { client, rec } = makeFakeClient();
  const res = await executePermanentDelete(client, "Trash", 42);
  assert.deepEqual(res, { kind: "permanent-delete", sourceUid: 42 });
  assert.equal(rec.messageDelete.length, 1);
  assert.equal(rec.messageMove.length, 0);
  assert.equal(rec.lockAcquired, 1);
  assert.equal(rec.lockReleased, 1);
  const call = rec.messageDelete[0];
  assert.deepEqual(call.query, { uid: "42" });
  assert.deepEqual(call.options, { uid: true });
});

test("executePermanentDelete: messageDelete=false → throws, lock still released", async () => {
  const { client, rec } = makeFakeClient({ messageDeleteReturns: false });
  await assert.rejects(() => executePermanentDelete(client, "Trash", 7));
  assert.equal(rec.messageDelete.length, 1);
  assert.equal(rec.messageMove.length, 0);
  assert.equal(rec.lockReleased, 1);
});

test("executePermanentDelete: messageDelete throws → lock still released, no move", async () => {
  const { client, rec } = makeFakeClient({
    messageDeleteThrows: new Error("network"),
  });
  await assert.rejects(() => executePermanentDelete(client, "Trash", 9), /network/);
  assert.equal(rec.messageDelete.length, 1);
  assert.equal(rec.messageMove.length, 0);
  assert.equal(rec.lockReleased, 1);
});
