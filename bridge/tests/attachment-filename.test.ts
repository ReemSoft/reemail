import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeAttachmentFilename } from "../src/attachment-filename.js";
import { parsedMailToMessage } from "../src/imap.js";

const properArabic =
  "\u062a\u0642\u0631\u064a\u0631 \u0627\u0644\u0645\u0634\u0631\u0648\u0639.pdf";
const westernUnicode = "R\u00e9sum\u00e9 final.pdf";
const originalArabic =
  "\u0637\u0644\u0628\u064a\u0629 5 \u0639\u0645\u0644\u0627\u0621\u060c \u062e\u0645\u064a\u0633 \u0645\u0634\u064a\u0637.pdf";
const mixed =
  "Project-2026 (\u0627\u0644\u0646\u0633\u062e\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629) - v2.pdf";

function asLatin1Mojibake(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

const vectors = [
  properArabic,
  "report.pdf",
  westernUnicode,
  originalArabic,
  mixed,
  asLatin1Mojibake(originalArabic),
  asLatin1Mojibake(mixed),
  "file%20name.pdf",
  "100% report.pdf",
  "UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf",
  "broken-\u00c3(.pdf",
];

test("preserves valid Arabic, ASCII, Western Unicode, and literal percent names", () => {
  assert.equal(normalizeAttachmentFilename(properArabic), properArabic);
  assert.equal(normalizeAttachmentFilename("report.pdf"), "report.pdf");
  assert.equal(normalizeAttachmentFilename(westernUnicode), westernUnicode);
  assert.equal(normalizeAttachmentFilename("100% report.pdf"), "100% report.pdf");
  assert.equal(normalizeAttachmentFilename("file%20name.pdf"), "file%20name.pdf");
});

test("repairs generated UTF-8-as-Latin1 mojibake exactly", () => {
  assert.equal(normalizeAttachmentFilename(asLatin1Mojibake(originalArabic)), originalArabic);
  assert.equal(normalizeAttachmentFilename(asLatin1Mojibake(mixed)), mixed);
  assert.equal(
    normalizeAttachmentFilename(asLatin1Mojibake(asLatin1Mojibake(originalArabic))),
    originalArabic,
  );
});

test("decodes only explicit RFC2231 UTF-8 percent form", () => {
  assert.equal(
    normalizeAttachmentFilename("UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf"),
    "\u062a\u0642\u0631\u064a\u0631.pdf",
  );
});

test("keeps invalid byte candidates and never introduces replacement characters", () => {
  const invalid = "broken-\u00c3(.pdf";
  const result = normalizeAttachmentFilename(invalid);
  assert.equal(result, invalid);
  assert.doesNotMatch(result, /\uFFFD/);
});

test("normalization is idempotent for every filename vector", () => {
  for (const value of vectors) {
    const once = normalizeAttachmentFilename(value);
    assert.equal(normalizeAttachmentFilename(once), once, value);
  }
});

test("parsed mail attachment metadata uses the same canonical filename", () => {
  const message = parsedMailToMessage(
    {
      attachments: [
        {
          checksum: "checksum",
          filename: asLatin1Mojibake(originalArabic),
          size: 4,
          contentType: "application/pdf",
        },
      ],
    } as never,
    "inbox",
  );
  assert.equal(message.attachments?.[0]?.filename, originalArabic);
});

test("message-open normalization remains pure metadata work with no extra IMAP operation", () => {
  const source = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const collect = source.slice(
    source.indexOf("export function collectAttachmentParts("),
    source.indexOf("function detectAttachments("),
  );
  assert.match(collect, /normalizeAttachmentFilename/);
  assert.doesNotMatch(collect, /download\(|fetchOne|simpleParser|parseMessageSource/);
});
