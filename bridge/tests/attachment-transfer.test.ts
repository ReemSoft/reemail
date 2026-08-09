import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  attachmentContentDisposition,
  sanitizeAttachmentFilename,
} from "../src/attachment-transfer.js";

test("download disposition preserves Arabic filenames with RFC5987", () => {
  const filename = sanitizeAttachmentFilename("تقرير أغسطس.pdf");
  const value = attachmentContentDisposition(filename, "application/pdf", "download");
  assert.match(value, /^attachment;/);
  assert.match(value, /filename\*=UTF-8''%D8/);
  assert.doesNotMatch(value, /[\r\n]/);
});

test("preview is inline only for the conservative MIME allowlist", () => {
  assert.match(attachmentContentDisposition("safe.pdf", "application/pdf", "preview"), /^inline;/);
  assert.match(attachmentContentDisposition("page.html", "text/html", "preview"), /^attachment;/);
  assert.match(
    attachmentContentDisposition("vector.svg", "image/svg+xml", "preview"),
    /^attachment;/,
  );
});

test("direct download holds the transfer mailbox operation through pipeline", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const direct = source.slice(
    source.indexOf('app.get("/api/direct/attachment-download"'),
    source.indexOf('app.post("/api/attachment"'),
  );
  assert.match(direct, /withAccountMailbox/);
  assert.match(direct, /"transfer"/);
  assert.match(direct, /await pipeline\(download\.content, res\)/);
  assert.match(direct, /dropAccountConnection\([^)]*"transfer"/s);
  assert.doesNotMatch(direct, /makeImapClient|Content-Length/);
});
