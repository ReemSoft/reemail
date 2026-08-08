import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Readable } from "node:stream";
import {
  getLargeInlinePart,
  LARGE_INLINE_PART_MAX_BYTES,
  type LargeInlinePartDependencies,
} from "../src/imap.js";
import type { MailAccount } from "../src/types.js";

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

function dependenciesFor(client: object, onDrop = () => {}): LargeInlinePartDependencies {
  return {
    getMailboxes: async () => [{ path: "INBOX" }] as never,
    withMailbox: async (_account, _password, path, operation, lane) => {
      assert.equal(path, "INBOX");
      assert.equal(lane, "interactive");
      return operation(client as never);
    },
    dropConnection: (_account, lane) => {
      assert.equal(lane, "interactive");
      onDrop();
    },
  };
}

test("two large CID requests reuse the interactive mailbox path without connect/login", async () => {
  const calls: Array<{ uid: string; part: string; options: unknown }> = [];
  const streams: Readable[] = [];
  const client = {
    connect() {
      throw new Error("large CID must not create or connect a client");
    },
    async download(uid: string, part: string, options: unknown) {
      calls.push({ uid, part, options });
      const content = Readable.from([Buffer.from("png-bytes")]);
      streams.push(content);
      return {
        content,
        meta: { contentType: "image/png", expectedSize: 9 },
      };
    },
  };
  const dependencies = dependenciesFor(client);

  const first = await getLargeInlinePart(
    account,
    "password",
    "inbox",
    42,
    "2",
    undefined,
    dependencies,
  );
  const second = await getLargeInlinePart(
    account,
    "password",
    "inbox",
    43,
    "2.1",
    undefined,
    dependencies,
  );

  assert.equal(first?.bytes.toString(), "png-bytes");
  assert.equal(second?.bytes.toString(), "png-bytes");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, { uid: true, maxBytes: LARGE_INLINE_PART_MAX_BYTES });
  assert.ok(
    streams.every((stream) => stream.readableEnded),
    "each literal must be fully consumed",
  );
  const source = readFileSync("src/imap.ts", "utf8");
  const sharedPath = source.slice(
    source.indexOf("export async function getLargeInlinePart"),
    source.indexOf("export async function downloadAttachment"),
  );
  assert.ok(sharedPath.includes("dependencies.getMailboxes"));
  assert.ok(sharedPath.includes("dependencies.withMailbox"));
  assert.doesNotMatch(sharedPath, /makeImapClient|\.connect\(|\.logout\(/);
});

test("large CID endpoint helper enforces raster MIME and the 5 MiB expected-size cap", async () => {
  let mode: "svg" | "oversize" = "svg";
  const client = {
    async download() {
      return {
        content: Readable.from([Buffer.from("bytes")]),
        meta:
          mode === "svg"
            ? { contentType: "image/svg+xml", expectedSize: 5 }
            : { contentType: "image/png", expectedSize: LARGE_INLINE_PART_MAX_BYTES + 1 },
      };
    },
  };
  const dependencies = dependenciesFor(client);
  assert.equal(
    await getLargeInlinePart(account, "password", "inbox", 42, "2", undefined, dependencies),
    null,
  );
  mode = "oversize";
  assert.equal(
    await getLargeInlinePart(account, "password", "inbox", 42, "2", undefined, dependencies),
    null,
  );
});

test("abort poisons and releases the operation before the next shared-session request", async () => {
  let attempt = 0;
  let active = 0;
  let drops = 0;
  let started!: () => void;
  const downloadStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = {
    async download() {
      attempt += 1;
      if (attempt === 1) {
        started();
        return {
          content: new Readable({ read() {} }),
          meta: { contentType: "image/png" },
        };
      }
      return {
        content: Readable.from([Buffer.from("next")]),
        meta: { contentType: "image/png", expectedSize: 4 },
      };
    },
  };
  const dependencies = dependenciesFor(client, () => drops++);
  dependencies.withMailbox = async (_account, _password, _path, operation) => {
    active += 1;
    try {
      return await operation(client as never);
    } finally {
      active -= 1;
    }
  };
  const controller = new AbortController();
  const aborted = getLargeInlinePart(
    account,
    "password",
    "inbox",
    42,
    "2",
    controller.signal,
    dependencies,
  );
  await downloadStarted;
  controller.abort();
  await assert.rejects(aborted, /aborted/);
  assert.equal(drops, 1);
  assert.equal(active, 0, "mailbox operation must release after the literal is destroyed");

  const next = await getLargeInlinePart(
    account,
    "password",
    "inbox",
    43,
    "2",
    undefined,
    dependencies,
  );
  assert.equal(next?.bytes.toString(), "next");
});
