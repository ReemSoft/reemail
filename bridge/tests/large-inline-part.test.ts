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

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_BYTES = Buffer.from("ffd8ffe0", "hex");

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
  Object.assign(client, { mailbox: { uidValidity: "77" } });
  return {
    getMailboxes: async () => [{ path: "INBOX" }] as never,
    withMailbox: async (_account, _password, path, operation, lane) => {
      assert.equal(path, "INBOX");
      assert.equal(lane, "media");
      return operation(client as never);
    },
    dropConnection: (_account, lane) => {
      assert.equal(lane, "media");
      onDrop();
    },
  };
}

test("two large CID requests reuse the media mailbox path without connect/login", async () => {
  const calls: Array<{ uid: string; part: string; options: unknown }> = [];
  const streams: Readable[] = [];
  const client = {
    connect() {
      throw new Error("large CID must not create or connect a client");
    },
    async download(uid: string, part: string, options: unknown) {
      calls.push({ uid, part, options });
      const content = Readable.from([PNG_BYTES]);
      streams.push(content);
      return {
        content,
        meta: { contentType: "image/png", expectedSize: PNG_BYTES.length },
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
    "77",
    undefined,
    dependencies,
  );
  const second = await getLargeInlinePart(
    account,
    "password",
    "inbox",
    43,
    "2.1",
    "77",
    undefined,
    dependencies,
  );

  assert.equal(first?.bytes.toString("hex"), PNG_BYTES.toString("hex"));
  assert.equal(second?.bytes.toString("hex"), PNG_BYTES.toString("hex"));
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

test("large CID endpoint helper fails closed for non-image bytes and the 5 MiB expected-size cap", async () => {
  let mode: "non-image" | "oversize" = "non-image";
  const client = {
    async download() {
      return {
        content: Readable.from([mode === "non-image" ? Buffer.from("<svg>") : PNG_BYTES]),
        meta:
          mode === "non-image"
            ? { contentType: "image/svg+xml", expectedSize: 5 }
            : { contentType: "image/png", expectedSize: LARGE_INLINE_PART_MAX_BYTES + 1 },
      };
    },
  };
  const dependencies = dependenciesFor(client);
  assert.equal(
    await getLargeInlinePart(account, "password", "inbox", 42, "2", "77", undefined, dependencies),
    null,
  );
  mode = "oversize";
  assert.equal(
    await getLargeInlinePart(account, "password", "inbox", 42, "2", "77", undefined, dependencies),
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
        content: Readable.from([PNG_BYTES]),
        meta: { contentType: "image/png", expectedSize: PNG_BYTES.length },
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
    "77",
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
    "77",
    undefined,
    dependencies,
  );
  assert.equal(next?.bytes.toString("hex"), PNG_BYTES.toString("hex"));
});

test("large CID fails closed before download when UIDVALIDITY changed", async () => {
  let downloads = 0;
  const client = {
    mailbox: { uidValidity: "88" },
    async download() {
      downloads += 1;
      throw new Error("must not download a reused UID");
    },
  };
  const dependencies = dependenciesFor(client);
  (client.mailbox as { uidValidity: string }).uidValidity = "88";

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
  assert.equal(result, null);
  assert.equal(downloads, 0);
});

test("large single part canonicalizes MIME from decoded bytes (JPEG declared image/png)", async () => {
  const client = {
    async download() {
      return {
        content: Readable.from([JPEG_BYTES]),
        meta: { contentType: "image/png", expectedSize: JPEG_BYTES.length },
      };
    },
  };
  const dependencies = dependenciesFor(client);
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
  assert.equal(result?.mimeType, "image/jpeg");
  assert.equal(result?.bytes.toString("hex"), JPEG_BYTES.toString("hex"));
});

test("large batch canonicalizes MIME from decoded bytes (source guard)", () => {
  const source = readFileSync("src/imap.ts", "utf8");
  const batch = source.slice(
    source.indexOf("export async function getLargeInlinePartsBatch"),
    source.indexOf("export interface LargeInlinePartDependencies"),
  );
  assert.match(batch, /sniffImageMime\(result\.buf\)/);
  assert.doesNotMatch(batch, /result\?\.meta\?\.contentType/);
  assert.doesNotMatch(batch, /\.replace\("image\/jpg", "image\/jpeg"\)/);
});
