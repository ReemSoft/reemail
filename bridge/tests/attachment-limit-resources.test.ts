import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const inlineImagesSource = readFileSync(
  new URL("../src/inline-images.ts", import.meta.url),
  "utf8",
);
const sendV2 = indexSource.slice(
  indexSource.indexOf('app.post("/api/send-v2"'),
  indexSource.indexOf("// ---- Drafts"),
);
const draftV2 = indexSource.slice(
  indexSource.indexOf('app.post("/api/draft-save-v2"'),
  indexSource.indexOf("// ---- Drafts"),
);
const schemas = indexSource.slice(
  indexSource.indexOf("const SendV2PayloadSchema"),
  indexSource.indexOf("const DownloadTicketPayloadSchema"),
);
const sendV2Handler = indexSource.slice(
  indexSource.indexOf('app.post("/api/send-v2"'),
  indexSource.indexOf('app.post("/api/draft-save-v2"'),
);
const draftV2Handler = indexSource.slice(
  indexSource.indexOf('app.post("/api/draft-save-v2"'),
  indexSource.indexOf("// ---- Drafts"),
);

test("separate resource-class constants match the approved model", () => {
  assert.match(indexSource, /const MAX_NORMAL_ATTACHMENTS = 10;/);
  assert.match(indexSource, /const MAX_INLINE_IMAGES = 50;/);
  assert.match(indexSource, /const MAX_TOTAL_FILE_PARTS = 60;/);
  assert.match(indexSource, /SEND_MAX_TOTAL_BYTES \|\| 25 \* 1024 \* 1024/);
});

test("v2 payload schemas allow 50 staged inline images while normal/source stay at 10", () => {
  assert.match(
    schemas,
    /stagedInlineImages: z\.array\(StagedInlineSchema\)\.max\(50\)\.default\(\[\]\),/,
  );
  assert.match(schemas, /attachmentHandles:[\s\S]*?\.max\(10\)/);
  assert.match(schemas, /sourceAttachments: z\.array\(ServerAttachmentSourceSchema\)\.max\(10\)/);
});

test("send-v2 combines staged normal handles + server-source attachments for the normal 10-cap", () => {
  assert.match(sendV2, /const normalParts = normal\.length \+ sourceAttachments\.length;/);
  assert.match(sendV2, /const inlineParts = inline\.length;/);
});

test("draft-save-v2 combines staged normal handles + preserved server-source attachments for the normal 10-cap", () => {
  assert.match(draftV2, /const normalParts = resolvedNormal\.length \+ preserved\.length;/);
  assert.match(
    draftV2,
    /const inlineParts = resolvedInline\.length \+ preservedInlineSources\.length;/,
  );
});

test("send-v2 and draft-save-v2 enforce normal<=10, inline<=50, total<=60, bytes unchanged", () => {
  const semantic =
    /normalParts > MAX_NORMAL_ATTACHMENTS\s*\|\|\s*inlineParts > MAX_INLINE_IMAGES\s*\|\|\s*normalParts \+ inlineParts > MAX_TOTAL_FILE_PARTS\s*\|\|\s*all\.reduce\(\(sum, item\) => sum \+ item\.size, 0\) > SEND_MAX_TOTAL_BYTES/;
  assert.match(sendV2, semantic);
  assert.match(draftV2, semantic);
});

test("total decoded-byte limit is never weakened in either v2 handler", () => {
  assert.match(
    sendV2,
    /all\.reduce\(\(sum, item\) => sum \+ item\.size, 0\) > SEND_MAX_TOTAL_BYTES/,
  );
  assert.match(
    draftV2,
    /all\.reduce\(\(sum, item\) => sum \+ item\.size, 0\) > SEND_MAX_TOTAL_BYTES/,
  );
});

test("per-inline 5 MiB limit is unchanged", () => {
  assert.match(inlineImagesSource, /export const INLINE_IMAGE_MAX_BYTES = 5 \* 1024 \* 1024;/);
});

test("InlineImageMetadataSchema keeps security validation at the higher 50-cap", () => {
  assert.match(inlineImagesSource, /\.max\(50\)/);
  assert.match(inlineImagesSource, /DUPLICATE_INLINE_IMAGE/);
  assert.match(inlineImagesSource, /sniffImageMime/);
  assert.match(inlineImagesSource, /INLINE_IMAGE_MIME_TYPES/);
});

test("legacy multer routes are not loosened: SEND_MAX_FILES stays 10", () => {
  assert.match(
    indexSource,
    /const SEND_MAX_FILES = Number\(process\.env\.SEND_MAX_FILES \|\| 10\);/,
  );
  assert.match(indexSource, /sendUpload\.array\("attachments", SEND_MAX_FILES\)/);
  assert.match(indexSource, /files: SEND_MAX_FILES/);
});

test("send-v2 rejects 10 handles + 1 source before stageServerAttachmentSources", () => {
  const rawCheck =
    /payload\.attachmentHandles\.length \+ payload\.sourceAttachments\.length\s*>\s*MAX_NORMAL_ATTACHMENTS/;
  const checkAt = sendV2Handler.search(rawCheck);
  const stageAt = sendV2Handler.indexOf("stageServerAttachmentSources(");
  const resolveAt = sendV2Handler.indexOf("resolveStagedAttachment(");
  assert.ok(checkAt >= 0, "raw-payload fail-fast check must exist in send-v2");
  assert.ok(stageAt > 0, "stageServerAttachmentSources must exist in send-v2");
  assert.ok(resolveAt > 0, "handle resolution must exist in send-v2");
  assert.ok(
    checkAt < resolveAt && checkAt < stageAt,
    "raw-payload check must run before handle resolution and source staging",
  );
});

test("send-v2 rejects 1 handle + 10 sources before IMAP/source staging", () => {
  const rawCheck =
    /payload\.attachmentHandles\.length \+ payload\.sourceAttachments\.length\s*>\s*MAX_NORMAL_ATTACHMENTS/;
  const checkAt = sendV2Handler.search(rawCheck);
  const stageAt = sendV2Handler.indexOf("stageServerAttachmentSources(");
  assert.ok(checkAt >= 0);
  assert.ok(stageAt > 0);
  assert.ok(checkAt < stageAt, "the combined-count check must precede source staging");
});

test("draft-save-v2 has the same fail-fast behavior", () => {
  const rawCheck =
    /contract\.attachmentHandles\.length \+ contract\.sourceAttachments\.length\s*>\s*MAX_NORMAL_ATTACHMENTS/;
  const checkAt = draftV2Handler.search(rawCheck);
  const stageAt = draftV2Handler.indexOf("stageDraftServerAttachmentSources(");
  const resolveAt = draftV2Handler.indexOf("resolveStagedAttachment(");
  assert.ok(checkAt >= 0, "raw-payload fail-fast check must exist in draft-save-v2");
  assert.ok(stageAt > 0, "Draft source staging must exist in draft-save-v2");
  assert.ok(resolveAt > 0, "handle resolution must exist in draft-save-v2");
  assert.ok(
    checkAt < resolveAt && checkAt < stageAt,
    "raw-payload check must run before handle resolution and source staging",
  );
});

test("raw fail-fast uses the existing 413 ATTACHMENTS_TOO_LARGE convention", () => {
  assert.match(
    sendV2Handler,
    /res\.status\(413\)\.json\(\{ ok: false, error: "ATTACHMENTS_TOO_LARGE" \}\);/,
  );
  assert.match(
    draftV2Handler,
    /res\.status\(413\)\.json\(\{ ok: false, error: "ATTACHMENTS_TOO_LARGE" \}\);/,
  );
});

test("10 total normal attachments remains allowed by raw count (strict >, not >=)", () => {
  assert.match(
    sendV2Handler,
    /payload\.attachmentHandles\.length \+ payload\.sourceAttachments\.length\s*>\s*MAX_NORMAL_ATTACHMENTS/,
  );
  assert.doesNotMatch(
    sendV2Handler,
    /payload\.attachmentHandles\.length \+ payload\.sourceAttachments\.length\s*>=\s*MAX_NORMAL_ATTACHMENTS/,
  );
});

test("inline images do not consume the normal 10-count in the raw fail-fast check", () => {
  const check =
    /payload\.attachmentHandles\.length \+ payload\.sourceAttachments\.length\s*>\s*MAX_NORMAL_ATTACHMENTS/;
  assert.match(sendV2Handler, check);
  assert.doesNotMatch(
    sendV2Handler,
    /stagedInlineImages[\s\S]{0,120}payload\.attachmentHandles\.length \+ payload\.sourceAttachments\.length/,
  );
  assert.match(
    draftV2Handler,
    /contract\.attachmentHandles\.length \+ contract\.sourceAttachments\.length\s*>\s*MAX_NORMAL_ATTACHMENTS/,
  );
});

test("downstream semantic and decoded-byte checks remain intact after the raw fail-fast check", () => {
  const semantic =
    /normalParts > MAX_NORMAL_ATTACHMENTS\s*\|\|\s*inlineParts > MAX_INLINE_IMAGES\s*\|\|\s*normalParts \+ inlineParts > MAX_TOTAL_FILE_PARTS\s*\|\|\s*all\.reduce\(\(sum, item\) => sum \+ item\.size, 0\) > SEND_MAX_TOTAL_BYTES/;
  assert.match(sendV2Handler, semantic);
  assert.match(draftV2Handler, semantic);
});
