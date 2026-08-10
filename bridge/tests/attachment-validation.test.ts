import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyAttachmentValidationFailure } from "../src/attachment-validation.js";

test("send-v2 distinguishes wrong normal kind internally and keeps the public error generic", () => {
  assert.equal(
    classifyAttachmentValidationFailure([{ kind: "inline-image", filename: "x.png" }], []),
    "NORMAL_ATTACHMENT_KIND_MISMATCH",
  );
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const sendV2 = source.slice(
    source.indexOf('app.post("/api/send-v2"'),
    source.indexOf('app.post("/api/mail-sent-copy-status"'),
  );
  assert.match(sendV2, /classifyAttachmentValidationFailure/);
  assert.match(sendV2, /error: "ATTACHMENT_KIND_MISMATCH"/);
});

test("send-v2 distinguishes wrong inline kind internally", () => {
  assert.equal(
    classifyAttachmentValidationFailure(
      [],
      [
        {
          item: { uploadFilename: "x.png" },
          staged: { kind: "attachment", filename: "x.png" },
        },
      ],
    ),
    "INLINE_ATTACHMENT_KIND_MISMATCH",
  );
});

test("send-v2 distinguishes inline filename mismatch internally", () => {
  assert.equal(
    classifyAttachmentValidationFailure(
      [],
      [
        {
          item: { uploadFilename: "declared.png" },
          staged: { kind: "inline-image", filename: "ticketed.png" },
        },
      ],
    ),
    "INLINE_ATTACHMENT_FILENAME_MISMATCH",
  );
});

test("send-v2 accepts correctly separated normal and inline descriptors", () => {
  assert.equal(
    classifyAttachmentValidationFailure(
      [{ kind: "attachment", filename: "report.pdf" }],
      [
        {
          item: { uploadFilename: "mm-inline.png" },
          staged: { kind: "inline-image", filename: "mm-inline.png" },
        },
      ],
    ),
    null,
  );
});
