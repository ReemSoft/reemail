/**
 * MAILMAESTRO_IMAP_SINGLE_CONNECTION — body-part selection tests.
 *
 * `getMessageBody` no longer downloads the full RFC822 source. It picks the
 * display part out of BODYSTRUCTURE and downloads only that. These tests lock
 * the selection rules so attachments never get mistaken for the body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTextPart, collectAttachmentParts, findUniqueCidAttachment } from "../src/imap.js";
import { imapConnectionStats, closeAllImapConnections } from "../src/imap-connection.js";

const plainOnly = {
  type: "text/plain",
  parameters: { charset: "utf-8" },
  size: 120,
};

const alternative = {
  type: "multipart/alternative",
  childNodes: [
    { type: "text/plain", part: "1", parameters: { charset: "iso-8859-1" }, size: 100 },
    { type: "text/html", part: "2", parameters: { charset: "utf-8" }, size: 400 },
  ],
};

const mixedWithAttachment = {
  type: "multipart/mixed",
  childNodes: [
    alternative,
    {
      type: "application/pdf",
      part: "3",
      disposition: "attachment",
      dispositionParameters: { filename: "invoice.pdf" },
      size: 4_000_000,
    },
  ],
};

const relatedWithInlineImage = {
  type: "multipart/related",
  childNodes: [
    { type: "text/html", part: "1", parameters: { charset: "utf-8" }, size: 900 },
    {
      type: "image/png",
      part: "2",
      disposition: "inline",
      id: "<logo@mm>",
      dispositionParameters: { filename: "logo.png" },
      size: 12_000,
    },
  ],
};

test("single-part text message resolves to part 1", () => {
  const pick = pickTextPart(plainOnly);
  assert.ok(pick);
  assert.equal(pick!.part, "1");
  assert.equal(pick!.type, "text/plain");
  assert.equal(pick!.charset, "utf-8");
});

test("single-part html message resolves to its exact part", () => {
  const pick = pickTextPart({ type: "text/html", part: "4.2", parameters: { charset: "utf-8" } });
  assert.deepEqual(pick, { part: "4.2", type: "text/html", charset: "utf-8" });
});

test("multipart/alternative prefers text/html over text/plain", () => {
  const pick = pickTextPart(alternative);
  assert.equal(pick!.part, "2");
  assert.equal(pick!.type, "text/html");
});

test("multipart/alternative falls back to plain when html is attachment-like", () => {
  const pick = pickTextPart({
    type: "multipart/alternative",
    childNodes: [
      { type: "text/plain", part: "1", parameters: { charset: "utf-8" } },
      {
        type: "text/html",
        part: "2",
        disposition: "attachment",
        dispositionParameters: { filename: "page.html" },
      },
    ],
  });
  assert.equal(pick?.part, "1");
  assert.equal(pick?.type, "text/plain");
});

test("text/plain charset is carried through when html is absent", () => {
  const pick = pickTextPart({
    type: "multipart/alternative",
    childNodes: [{ type: "text/plain", part: "1", parameters: { charset: "windows-1256" } }],
  });
  assert.equal(pick!.type, "text/plain");
  assert.equal(pick!.charset, "windows-1256");
});

test("an attachment is never selected as the body part", () => {
  const pick = pickTextPart(mixedWithAttachment);
  assert.equal(pick!.type, "text/html");
  assert.equal(pick!.part, "2");
});

test("multipart/mixed selects the first body-yielding child branch", () => {
  const pick = pickTextPart({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        childNodes: [
          { type: "text/plain", part: "1.1" },
          { type: "text/html", part: "1.2" },
        ],
      },
      { type: "text/html", part: "2" },
    ],
  });
  assert.equal(pick?.part, "1.2");
});

test("multipart/related selects its root html and never an inline image", () => {
  const pick = pickTextPart(relatedWithInlineImage);
  assert.equal(pick?.part, "1");
  assert.equal(pick?.type, "text/html");
});

test("multipart/related honors a resolvable start content-id", () => {
  const pick = pickTextPart({
    type: "multipart/related",
    parameters: { start: "<root@mm>" },
    childNodes: [
      { type: "text/plain", part: "1", id: "other@mm" },
      { type: "text/html", part: "2", id: "<ROOT@MM>" },
      { type: "image/png", part: "3", id: "image@mm" },
    ],
  });
  assert.equal(pick?.part, "2");
});

test("multipart/related falls back to its first appropriate child when start is absent", () => {
  const pick = pickTextPart({
    type: "multipart/related",
    childNodes: [
      { type: "image/png", part: "1", id: "image@mm" },
      { type: "text/plain", part: "2" },
      { type: "text/html", part: "3" },
    ],
  });
  assert.equal(pick?.part, "2");
});

test("nested mixed -> alternative -> related resolves the representation tree", () => {
  const pick = pickTextPart({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        childNodes: [
          { type: "text/plain", part: "1.1" },
          {
            type: "multipart/related",
            childNodes: [
              { type: "text/html", part: "1.2.1", parameters: { charset: "windows-1256" } },
              { type: "image/jpeg", part: "1.2.2", id: "photo@mm" },
            ],
          },
        ],
      },
      { type: "application/pdf", part: "2", disposition: "attachment" },
    ],
  });
  assert.deepEqual(pick, { part: "1.2.1", type: "text/html", charset: "windows-1256" });
});

test("outer plain body wins over html inside an attached message/rfc822", () => {
  const pick = pickTextPart({
    type: "multipart/mixed",
    childNodes: [
      { type: "text/plain", part: "1" },
      {
        type: "message/rfc822",
        part: "2",
        disposition: "attachment",
        childNodes: [{ type: "text/html", part: "2" }],
      },
    ],
  });
  assert.equal(pick?.part, "1");
  assert.equal(pick?.type, "text/plain");
});

test("outer html body is retained when an attached message also has html", () => {
  const pick = pickTextPart({
    type: "multipart/mixed",
    childNodes: [
      { type: "text/html", part: "1" },
      {
        type: "message/rfc822",
        part: "2",
        childNodes: [{ type: "text/html", part: "2" }],
      },
    ],
  });
  assert.equal(pick?.part, "1");
});

test("message/rfc822 alone never exposes its nested message body", () => {
  assert.equal(
    pickTextPart({
      type: "message/rfc822",
      part: "1",
      childNodes: [{ type: "text/html", part: "1" }],
    }),
    null,
  );
});

test("a text/plain part with a filename is treated as an attachment, not the body", () => {
  const pick = pickTextPart({
    type: "multipart/mixed",
    childNodes: [
      { type: "text/html", part: "1", parameters: { charset: "utf-8" } },
      {
        type: "text/plain",
        part: "2",
        disposition: "attachment",
        dispositionParameters: { filename: "notes.txt" },
      },
    ],
  });
  assert.equal(pick!.part, "1");
});

test("a text/html disposition attachment is excluded from body selection", () => {
  assert.equal(
    pickTextPart({
      type: "text/html",
      part: "1",
      disposition: "attachment",
    }),
    null,
  );
});

test("a multipart attachment branch cannot donate nested text", () => {
  const pick = pickTextPart({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        disposition: "attachment",
        dispositionParameters: { filename: "saved-message.mime" },
        childNodes: [{ type: "text/html", part: "1.1" }],
      },
      { type: "text/plain", part: "2" },
    ],
  });
  assert.equal(pick?.part, "2");
});

test("related image-only parts never become a body", () => {
  assert.equal(
    pickTextPart({
      type: "multipart/related",
      childNodes: [
        { type: "image/png", part: "1", id: "one@mm" },
        { type: "image/jpeg", part: "2", id: "two@mm" },
      ],
    }),
    null,
  );
});

test("returns null when the structure carries no displayable text part", () => {
  assert.equal(
    pickTextPart({
      type: "multipart/mixed",
      childNodes: [
        {
          type: "application/pdf",
          part: "1",
          disposition: "attachment",
          dispositionParameters: { filename: "a.pdf" },
        },
      ],
    }),
    null,
  );
});

test("inline image parts remain discoverable with their cid + part number", () => {
  const parts = collectAttachmentParts(relatedWithInlineImage);
  const logo = parts.find((p) => (p.contentId || "").includes("logo@mm"));
  assert.ok(logo);
  assert.equal(logo!.part, "2");
  assert.equal(logo!.mimeType, "image/png");
  assert.equal(logo!.size, 12_000);
});

test("CID image parts without filename or disposition remain discoverable", () => {
  const parts = collectAttachmentParts({
    type: "multipart/related",
    childNodes: [
      { type: "text/html", part: "1" },
      { type: "image/jpeg", part: "2", id: "<mobile-photo@example>", size: 450_000 },
    ],
  });
  assert.deepEqual(parts, [
    {
      id: "2",
      part: "2",
      filename: "attachment_1",
      size: 450_000,
      mimeType: "image/jpeg",
      disposition: undefined,
      contentId: "<mobile-photo@example>",
    },
  ]);
});

test("a duplicated Content-ID is ambiguous and never selects an arbitrary MIME part", () => {
  const duplicated = [
    {
      id: "2",
      part: "2",
      filename: "first.png",
      size: 10,
      mimeType: "image/png",
      contentId: "<same@mm>",
    },
    {
      id: "3",
      part: "3",
      filename: "second.png",
      size: 20,
      mimeType: "image/png",
      contentId: "SAME@MM",
    },
  ];
  assert.equal(findUniqueCidAttachment(duplicated, "same@mm"), null);
  assert.equal(findUniqueCidAttachment(duplicated.slice(0, 1), "SAME@MM")?.part, "2");
});

test("URL-encoded CID references match the canonical BODYSTRUCTURE id", () => {
  const attachments = [
    {
      id: "2",
      part: "2",
      filename: "photo.jpg",
      size: 100,
      mimeType: "image/jpeg",
      contentId: "<photo@example.com>",
    },
  ];
  assert.equal(findUniqueCidAttachment(attachments, "photo%40example.com")?.part, "2");
});

test("BODYSTRUCTURE attachment filenames are normalized without changing valid Arabic", () => {
  const validArabic = "\u062a\u0642\u0631\u064a\u0631.pdf";
  const mojibake = Buffer.from(validArabic, "utf8").toString("latin1");
  const parts = collectAttachmentParts({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "application/pdf",
        part: "1",
        disposition: "attachment",
        dispositionParameters: { filename: mojibake },
      },
      {
        type: "application/pdf",
        part: "2",
        disposition: "attachment",
        dispositionParameters: { filename: validArabic },
      },
    ],
  });
  assert.equal(parts[0]?.filename, validArabic);
  assert.equal(parts[1]?.filename, validArabic);
});

test("connection stats expose bounded config only (no host/account identifiers)", async () => {
  const s = imapConnectionStats();

  // 1. exactly the five expected keys
  assert.deepEqual(Object.keys(s).sort(), [
    "idleCloseMs",
    "lanes",
    "listCacheMs",
    "maxConnectionsPerAccount",
    "openConnections",
  ]);
  assert.deepEqual(Object.keys(s.lanes).sort(), [
    "background",
    "draft",
    "interactive",
    "media",
    "transfer",
  ]);

  assert.equal(typeof s.openConnections, "number");
  assert.ok(s.idleCloseMs > 0);
  assert.ok(s.listCacheMs > 0);

  // 2. lane counters are non-negative numbers
  for (const v of [
    s.lanes.interactive,
    s.lanes.media,
    s.lanes.background,
    s.lanes.transfer,
    s.lanes.draft,
  ]) {
    assert.equal(typeof v, "number");
    assert.ok(Number.isFinite(v) && v >= 0);
  }

  // 3. five connections per account max (interactive + media + background + transfer + draft)
  assert.equal(s.maxConnectionsPerAccount, 5);

  // 4. no PII / identifiers among the VALUES: every leaf value is a number,
  //    so no host, account, company, email or any personal identifier can leak.
  const leaves = [
    s.openConnections,
    s.maxConnectionsPerAccount,
    s.idleCloseMs,
    s.listCacheMs,
    s.lanes.interactive,
    s.lanes.media,
    s.lanes.background,
    s.lanes.transfer,
    s.lanes.draft,
  ];
  for (const v of leaves) assert.equal(typeof v, "number");
  const values = JSON.stringify(s)
    .toLowerCase()
    .replace(/"[a-z]+":/g, "");
  for (const forbidden of ["host", "account", "company", "email", "user", "pass", "@"]) {
    assert.ok(!values.includes(forbidden), `stats must not expose "${forbidden}"`);
  }

  // 5. closing everything zeroes the counters
  await closeAllImapConnections(); // no-op when nothing is open
  const after = imapConnectionStats();
  assert.equal(after.openConnections, 0);
  assert.equal(after.lanes.interactive, 0);
  assert.equal(after.lanes.media, 0);
  assert.equal(after.lanes.background, 0);
  assert.equal(after.lanes.transfer, 0);
});
