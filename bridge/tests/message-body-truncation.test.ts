import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDownloadedBodyTruncated, MESSAGE_BODY_MAX_BYTES, pickTextPart } from "../src/imap.js";

const kib = 1024;
const mib = 1024 * kib;

test("a normally completed body below the cap is complete", () => {
  assert.equal(
    isDownloadedBodyTruncated({ loadedBytes: 100 * kib, maxBytes: MESSAGE_BODY_MAX_BYTES }),
    false,
  );
});

test("a proven body larger than the cap is truncated at five MiB", () => {
  assert.equal(
    isDownloadedBodyTruncated({
      loadedBytes: 5 * mib,
      maxBytes: MESSAGE_BODY_MAX_BYTES,
      provenCompleteBytes: 6 * mib,
    }),
    true,
  );
});

test("a reliable complete size above loaded bytes is truncated", () => {
  assert.equal(
    isDownloadedBodyTruncated({
      loadedBytes: 200 * kib,
      maxBytes: MESSAGE_BODY_MAX_BYTES,
      provenCompleteBytes: 300 * kib,
    }),
    true,
  );
});

test("an exact-cap body is complete only with reliable proof", () => {
  assert.equal(
    isDownloadedBodyTruncated({
      loadedBytes: MESSAGE_BODY_MAX_BYTES,
      maxBytes: MESSAGE_BODY_MAX_BYTES,
      provenCompleteBytes: MESSAGE_BODY_MAX_BYTES,
    }),
    false,
  );
  assert.equal(
    isDownloadedBodyTruncated({
      loadedBytes: MESSAGE_BODY_MAX_BYTES,
      maxBytes: MESSAGE_BODY_MAX_BYTES,
    }),
    true,
  );
});

test("HTML and plain text use the same byte classification", () => {
  for (const type of ["text/html", "text/plain"]) {
    assert.equal(pickTextPart({ type, part: "1" })?.part, "1");
    assert.equal(
      isDownloadedBodyTruncated({
        loadedBytes: MESSAGE_BODY_MAX_BYTES,
        maxBytes: MESSAGE_BODY_MAX_BYTES,
      }),
      true,
    );
  }
});

test("no displayable body part yields no selected download to classify", () => {
  assert.equal(
    pickTextPart({
      type: "multipart/mixed",
      childNodes: [{ type: "application/pdf", part: "1", disposition: "attachment" }],
    }),
    null,
  );
});

test("getMessageBody keeps one bounded body download and no attachment-byte download", () => {
  const source = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const bodyPath = source.slice(
    source.indexOf("export async function getMessageBody("),
    source.indexOf("export async function downloadInlinePartsInMailbox("),
  );
  assert.equal(
    bodyPath.match(/downloadPartBuffer\(client, uid, pick\.part, MESSAGE_BODY_MAX_BYTES/g)?.length,
    1,
  );
  assert.doesNotMatch(bodyPath, /downloadPartBuffer\(client, uid, (?:partInfo|attachment)/);
  assert.match(bodyPath, /parsed\.bodyTruncated = true/);
  assert.match(bodyPath, /const structural = collectAttachmentParts\(msg\.bodyStructure\)/);
});
