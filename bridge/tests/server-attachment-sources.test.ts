import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("existing draft attachments stay on the Bridge data plane", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /withAccountMailbox/);
  assert.match(source, /stageAttachmentStream/);
  assert.match(source, /SOURCE_UIDVALIDITY_MISMATCH/);
  assert.match(source, /getMailboxesCached\(input\.account, input\.password, "transfer"\)/);
  assert.doesNotMatch(source, /"interactive"/);
  assert.doesNotMatch(source, /Buffer\.concat|\.build\(/);
});

test("server source transfer failure drops only the transfer connection", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /dropAccountConnection\(input\.account, "transfer"\)/);
  assert.doesNotMatch(source, /dropAccountConnection\(input\.account, "interactive"\)/);
});

test("empty server source list returns before account binding or IMAP work", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  const earlyReturn = source.indexOf("if (input.sources.length === 0) return []");
  assert.ok(earlyReturn > 0);
  assert.ok(earlyReturn < source.indexOf("accountBinding(input.account)"));
  assert.ok(earlyReturn < source.indexOf("getMailboxesCached("));
  assert.ok(earlyReturn < source.indexOf("withAccountMailbox("));
});
