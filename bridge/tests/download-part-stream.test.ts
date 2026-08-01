/**
 * downloadPartBuffer contract tests.
 *
 * Regression: the old implementation `break`ed out of the body stream once it
 * passed maxBytes. That left unread bytes on the shared per-account IMAP
 * connection, wedging every later request ("Failed to open message").
 *
 * Rules locked here:
 *   1. truncation is delegated to ImapFlow's own `maxBytes` (we pass it through)
 *   2. the stream is always consumed to the end — never abandoned mid-literal
 *   3. after an oversized part, the NEXT message download still works
 *   4. a stream error destroys the stream and drops the account connection
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { downloadPartBuffer } from "../src/imap.js";

function fakeClient(streams: Array<() => Readable>, calls: any[] = []) {
  let i = 0;
  return {
    calls,
    async download(uid: string, part: string, opts: any) {
      calls.push({ uid, part, opts });
      return { content: streams[i++](), meta: { contentType: "text/html" } };
    },
  } as any;
}

test("maxBytes is passed through to ImapFlow instead of a manual break", async () => {
  const calls: any[] = [];
  const client = fakeClient([() => Readable.from([Buffer.from("hello")])], calls);
  const got = await downloadPartBuffer(client, 42, "1", 1234);
  assert.equal(got!.buf.toString(), "hello");
  assert.deepEqual(calls[0].opts, { uid: true, maxBytes: 1234 });
});

test("the stream is fully consumed (no leftover bytes on the connection)", async () => {
  const chunks = [Buffer.alloc(10, 1), Buffer.alloc(10, 2), Buffer.alloc(10, 3)];
  const stream = Readable.from(chunks);
  const client = fakeClient([() => stream]);
  const got = await downloadPartBuffer(client, 1, "1", 15);
  // Everything the server handed us was read — the stream is exhausted.
  assert.equal(got!.buf.length, 30);
  assert.equal(stream.readableEnded, true);
});

test("the NEXT download still works after an oversized (truncated) part", async () => {
  // ImapFlow truncates at maxBytes and ends the stream itself.
  const truncated = () => Readable.from([Buffer.alloc(64, 9)]);
  const next = () => Readable.from([Buffer.from("second message body")]);
  const client = fakeClient([truncated, next]);

  const big = await downloadPartBuffer(client, 1, "1", 64);
  assert.equal(big!.buf.length, 64);

  const after = await downloadPartBuffer(client, 2, "1", 5 * 1024 * 1024);
  assert.equal(after!.buf.toString(), "second message body");
});

test("a stream error destroys the stream and drops the account connection", async () => {
  const stream = new Readable({
    read() {
      this.destroy(new Error("socket died"));
    },
  });
  const client = fakeClient([() => stream]);
  let dropped = 0;
  await assert.rejects(
    () => downloadPartBuffer(client, 1, "1", 1024, () => dropped++),
    /socket died/,
  );
  assert.equal(dropped, 1, "poisoned connection must be dropped from the cache");
  assert.equal(stream.destroyed, true);
});

test("a null content response is a clean null, not a throw", async () => {
  const client = { async download() { return { content: null }; } } as any;
  assert.equal(await downloadPartBuffer(client, 1, "1", 10), null);
});
