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
  assert.match(direct, /await pipeline\(download\.content, byteCounter, res\)/);
  assert.match(direct, /chunkSize: DOWNLOAD_CHUNK_BYTES/);
  assert.match(direct, /uid: true/);
  assert.match(direct, /maxBytes: ATTACHMENT_MAX_BYTES/);
  assert.match(direct, /X-MailMaestro-Download-Chunk-Bytes/);
  assert.match(direct, /download\.content\.destroy\(\)/);
  assert.match(direct, /downloadGates\.release\(gateKey\)/);
  assert.match(direct, /dropAccountConnection\([^)]*"transfer"/s);
  assert.doesNotMatch(
    direct,
    /makeImapClient|Content-Length|Buffer\.concat|streamToBuffer|downloadMany|res\.blob|readFile|writeFile|createWriteStream|supabase|interactive/,
  );
});

test("direct download rejects unsafe requests and releases its unchanged bounded gate", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const direct = source.slice(
    source.indexOf('app.get("/api/direct/attachment-download"'),
    source.indexOf('app.post("/api/attachment"'),
  );
  const gateConfig = source.slice(
    source.indexOf("const downloadGates"),
    source.indexOf('app.post("/api/attachment-download-ticket"'),
  );
  assert.match(direct, /openTransferTicket/);
  assert.match(direct, /accountBinding[^]*!== gateKey/);
  assert.match(direct, /payload\.size > ATTACHMENT_MAX_BYTES/);
  assert.match(direct, /expectedSize > ATTACHMENT_MAX_BYTES/);
  assert.match(direct, /if \(acquired\) downloadGates\.release\(gateKey\)/);
  assert.match(gateConfig, /MAIL_DOWNLOAD_GLOBAL_MAX \|\| 16/);
  assert.match(gateConfig, /MAIL_DOWNLOAD_ACCOUNT_MAX \|\| 1/);
});

test("message-open path cannot invoke the normal attachment downloader", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const messageRoute = indexSource.slice(
    indexSource.indexOf('app.post("/api/message"'),
    indexSource.indexOf('app.post("/api/message-inline-images"'),
  );
  const imapSource = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const messageBody = imapSource.slice(
    imapSource.indexOf("export async function getMessageBody("),
    imapSource.indexOf("export async function getInlineImagesBatch("),
  );
  assert.match(messageRoute, /getMessageBody/);
  assert.doesNotMatch(messageRoute, /downloadAttachment|attachment-download/);
  assert.doesNotMatch(messageBody, /downloadAttachment/);
  assert.match(messageBody, /selectInlineMetadataCandidates/);
  assert.match(messageBody, /metadata only/);
});

test("locked ImapFlow 1.5.0 uses sequential bounded partial FETCHes with drain", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../node_modules/imapflow/package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const source = readFileSync(
    new URL("../node_modules/imapflow/lib/imap-flow.js", import.meta.url),
    "utf8",
  );
  const download = source.slice(
    source.indexOf("async download("),
    source.indexOf("async downloadMany("),
  );
  assert.equal(packageJson.version, "1.5.0");
  assert.match(download, /chunkSize: 64 \* 1024/);
  assert.match(download, /maxLength: chunkSize/);
  assert.match(download, /await this\.fetchOne/);
  assert.match(download, /await getNextPart\(\)/);
  assert.match(download, /stream\.once\('drain'/);
  assert.match(download, /new LimitedPassthrough\(\{ maxBytes \}\)/);
});
