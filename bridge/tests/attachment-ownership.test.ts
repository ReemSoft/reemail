import assert from "node:assert/strict";
import test from "node:test";
import { collectAttachmentParts, visibleMessageAttachments } from "../src/imap.js";

function attachment(part: string, filename: string, type = "application/pdf", size = 1_024) {
  return {
    type,
    part,
    size,
    disposition: "attachment",
    dispositionParameters: { filename },
  };
}

function root(...childNodes: unknown[]) {
  return { type: "multipart/mixed", childNodes };
}

function attachedMessage(
  childNodes: unknown[],
  metadata: { part?: string; disposition?: string; filename?: string } = {},
) {
  return {
    type: "message/rfc822",
    part: metadata.part ?? "2",
    disposition: metadata.disposition,
    dispositionParameters: metadata.filename ? { filename: metadata.filename } : undefined,
    childNodes,
  };
}

test("collects a simple genuine outer PDF", () => {
  const parts = collectAttachmentParts(
    root({ type: "text/html", part: "1" }, attachment("2", "file.pdf")),
  );

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["file.pdf"],
  );
});

test("collects multiple genuine outer attachments", () => {
  const parts = collectAttachmentParts(
    root(
      { type: "text/html", part: "1" },
      attachment("2", "A.pdf"),
      attachment("3", "B.zip", "application/zip"),
    ),
  );

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["A.pdf", "B.zip"],
  );
});

test("message/rfc822 exposes original.eml but not its nested PDF", () => {
  const parts = collectAttachmentParts(
    root(
      { type: "text/html", part: "1" },
      attachedMessage(
        [root({ type: "text/html", part: "2.1.1" }, attachment("2.1.2", "file.pdf"))],
        { part: "2", disposition: "attachment", filename: "original.eml" },
      ),
    ),
  );

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["original.eml"],
  );
});

test("message/rfc822 excludes multiple nested files", () => {
  const parts = collectAttachmentParts(
    root(
      attachedMessage(
        [root(attachment("2.1", "nested.pdf"), attachment("2.2", "nested.zip", "application/zip"))],
        { part: "2", disposition: "attachment", filename: "original.eml" },
      ),
    ),
  );

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["original.eml"],
  );
});

test("message/rfc822 without attachment metadata remains a hard boundary", () => {
  const parts = collectAttachmentParts(
    root(attachedMessage([root(attachment("2.1", "nested.pdf"))])),
  );

  assert.deepEqual(parts, []);
});

test("an attachment-like multipart branch does not leak its nested files", () => {
  const attachedMultipart = {
    type: "multipart/mixed",
    part: "2",
    disposition: "attachment",
    dispositionParameters: { filename: "bundle.mime" },
    childNodes: [
      attachment("2.1", "nested.pdf"),
      attachment("2.2", "nested.zip", "application/zip"),
    ],
  };
  const parts = collectAttachmentParts(root(attachedMultipart, attachment("3", "outer.pdf")));

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["outer.pdf"],
  );
});

test("ordinary nested multipart structure still exposes an outer PDF", () => {
  const alternative = {
    type: "multipart/alternative",
    childNodes: [
      { type: "text/plain", part: "1.1" },
      { type: "text/html", part: "1.2" },
    ],
  };
  const parts = collectAttachmentParts(root(alternative, attachment("2", "outer.pdf")));

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["outer.pdf"],
  );
});

test("referenced related CID resources remain hidden from normal attachments", () => {
  const logo = {
    type: "image/png",
    part: "1.2",
    size: 512,
    id: "<logo@example.test>",
    disposition: "inline",
    dispositionParameters: { filename: "logo.png" },
  };
  const related = {
    type: "multipart/related",
    childNodes: [{ type: "text/html", part: "1.1" }, logo],
  };
  const structural = collectAttachmentParts(root(related, attachment("2", "outer.pdf")));
  const visible = visibleMessageAttachments(structural, new Set(["logo@example.test"]));

  assert.deepEqual(
    structural.map((part) => part.filename),
    ["logo.png", "outer.pdf"],
  );
  assert.deepEqual(
    visible.map((part) => part.filename),
    ["outer.pdf"],
  );
});

test("outer PDF and attached EML remain while the EML nested PDF is excluded", () => {
  const parts = collectAttachmentParts(
    root(
      attachment("2", "outer.pdf"),
      attachedMessage([root(attachment("3.1", "nested.pdf"))], {
        part: "3",
        disposition: "attachment",
        filename: "original.eml",
      }),
    ),
  );

  assert.deepEqual(
    parts.map((part) => part.filename),
    ["outer.pdf", "original.eml"],
  );
});

test("preserves part number, filename, size, MIME type, and disposition", () => {
  const [part] = collectAttachmentParts(
    root(attachment("4.2", "report.pdf", "application/pdf", 98_765)),
  );

  assert.deepEqual(part, {
    id: "4.2",
    part: "4.2",
    filename: "report.pdf",
    size: 98_765,
    mimeType: "application/pdf",
    disposition: "attachment",
    contentId: undefined,
  });
});

test("a message with no outer attachments remains attachment-free", () => {
  const parts = collectAttachmentParts(
    root(
      { type: "text/html", part: "1" },
      attachedMessage([root(attachment("2.1", "nested.pdf"))], { part: "2" }),
    ),
  );

  assert.deepEqual(parts, []);
});
