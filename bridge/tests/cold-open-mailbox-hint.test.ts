import { test } from "node:test";
import assert from "node:assert/strict";
import { withMessageMailbox } from "../src/imap.js";
import type { MailAccount } from "../src/types.js";

const account: MailAccount = {
  email_address: "mailbox@example.test",
  display_name: null,
  imap_host: "imap.example.test",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "smtp.example.test",
  smtp_port: 465,
  smtp_secure: true,
};

function harness(options?: {
  hintUidValidity?: string;
  failHintSelect?: boolean;
  operationError?: Error;
}) {
  const paths: string[] = [];
  let lists = 0;
  let operations = 0;
  const deps = {
    getMailboxes: async () => {
      lists++;
      return [{ path: "INBOX", specialUse: "\\Inbox" }];
    },
    withMailbox: async (
      _account: MailAccount,
      _password: string,
      path: string,
      operation: (client: unknown) => Promise<unknown>,
    ) => {
      paths.push(path);
      if (options?.failHintSelect && path === "Trusted/Inbox") {
        throw new Error("mailbox does not exist");
      }
      const client = {
        mailbox: {
          uidValidity: path === "Trusted/Inbox" ? (options?.hintUidValidity ?? "77") : "77",
        },
      };
      return operation(client);
    },
  };
  const open = () => {
    operations++;
    if (options?.operationError) throw options.operationError;
    return Promise.resolve("body");
  };
  return {
    deps,
    open,
    stats: () => ({ paths, lists, operations }),
  };
}

test("valid trusted hint skips LIST and opens the hinted physical mailbox once", async () => {
  const h = harness();
  const result = await withMessageMailbox(
    account,
    "password",
    "inbox",
    "interactive",
    { path: "Trusted/Inbox", expectedUidValidity: "77" },
    h.open,
    h.deps as never,
  );
  assert.equal(result, "body");
  assert.deepEqual(h.stats(), { paths: ["Trusted/Inbox"], lists: 0, operations: 1 });
});

test("missing hint preserves the existing LIST and canonical fallback", async () => {
  const h = harness();
  const result = await withMessageMailbox(
    account,
    "password",
    "inbox",
    "interactive",
    undefined,
    h.open,
    h.deps as never,
  );
  assert.equal(result, "body");
  assert.deepEqual(h.stats(), { paths: ["INBOX"], lists: 1, operations: 1 });
});

test("stale UIDVALIDITY performs no hinted FETCH and falls back safely", async () => {
  const h = harness({ hintUidValidity: "88" });
  const result = await withMessageMailbox(
    account,
    "password",
    "inbox",
    "interactive",
    { path: "Trusted/Inbox", expectedUidValidity: "77" },
    h.open,
    h.deps as never,
  );
  assert.equal(result, "body");
  assert.deepEqual(h.stats(), {
    paths: ["Trusted/Inbox", "INBOX"],
    lists: 1,
    operations: 1,
  });
});

test("renamed or invalid hinted path falls back to canonical resolution", async () => {
  const h = harness({ failHintSelect: true });
  const result = await withMessageMailbox(
    account,
    "password",
    "inbox",
    "interactive",
    { path: "Trusted/Inbox", expectedUidValidity: "77" },
    h.open,
    h.deps as never,
  );
  assert.equal(result, "body");
  assert.deepEqual(h.stats(), {
    paths: ["Trusted/Inbox", "INBOX"],
    lists: 1,
    operations: 1,
  });
});

test("an operation failure is not retried and cannot duplicate body downloads", async () => {
  const failure = new Error("BODY_DOWNLOAD_FAILED");
  const h = harness({ operationError: failure });
  await assert.rejects(
    withMessageMailbox(
      account,
      "password",
      "inbox",
      "interactive",
      { path: "Trusted/Inbox", expectedUidValidity: "77" },
      h.open,
      h.deps as never,
    ),
    failure,
  );
  assert.deepEqual(h.stats(), { paths: ["Trusted/Inbox"], lists: 0, operations: 1 });
});

test("malformed hints fail closed into the existing resolver", async () => {
  const h = harness();
  const result = await withMessageMailbox(
    account,
    "password",
    "inbox",
    "interactive",
    { path: "Trusted/Inbox", expectedUidValidity: "0" },
    h.open,
    h.deps as never,
  );
  assert.equal(result, "body");
  assert.deepEqual(h.stats(), { paths: ["INBOX"], lists: 1, operations: 1 });
});
