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
  const handler = source.slice(
    source.indexOf("export async function stageServerAttachmentSources"),
    source.indexOf("export interface ServerInlineSourceDeps"),
  );
  const earlyReturn = handler.indexOf("if (input.sources.length === 0) return []");
  assert.ok(earlyReturn > 0);
  assert.ok(earlyReturn < handler.indexOf("accountBinding(input.account)"));
  assert.ok(earlyReturn < handler.indexOf("getMailboxesCached("));
  assert.ok(earlyReturn < handler.indexOf("withAccountMailbox("));
});

test("whole-message RFC822/BODYSTRUCTURE encoded sizes never pre-reject a server-source attachment", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  // The old gate used `download.meta.expectedSize` (RFC822.SIZE, whole encoded
  // message) and fell back to `source.size` (encoded BODYSTRUCTURE octets) —
  // both are encoded, never decoded, so a small decoded attachment could be
  // rejected before the decoded stream was measured. Both are gone.
  assert.doesNotMatch(source, /expectedSize/);
  assert.doesNotMatch(source, /expectedSize\s*>\s*input\.maxBytes/);
  assert.doesNotMatch(source, /download\.content\.destroy\(\)/);
  // The size decision is delegated entirely to the decoded-stream limiter.
  assert.match(source, /maxSize: input\.maxBytes/);
});

test("decoded bytes are the authoritative size (encoded declared size never rejects)", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  // `declaredSize` (encoded BODYSTRUCTURE octets) is only used for metadata and
  // quota reservation; `exactSize: false` means it can never cause a
  // size-mismatch rejection, so an encoded part > the limit whose decoded
  // stream is under the limit stages successfully.
  assert.match(source, /declaredSize: source\.size/);
  assert.match(source, /exactSize: false/);
  assert.match(source, /maxSize: input\.maxBytes/);
});

test("decoded overflow is still rejected (no silent truncation at the limit)", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  // ImapFlow truncates the decoded stream at its own `maxBytes` without an
  // error. The fetch window is widened one byte past the limit so the decoded
  // limiter observes and rejects genuine overflow instead of staging a
  // truncated file as exactly-at-limit.
  assert.match(source, /maxBytes: input\.maxBytes \+ 1/);
  assert.match(source, /maxSize: input\.maxBytes/);
});

test("decoded overflow surfaces as the standard SOURCE_ATTACHMENT_TOO_LARGE condition", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /error\.message === "UPLOAD_TOO_LARGE"[\s\S]*throw new Error\("SOURCE_ATTACHMENT_TOO_LARGE"\)/,
  );
  assert.doesNotMatch(source, /throw new Error\("UPLOAD_TOO_LARGE"\)/);
});
