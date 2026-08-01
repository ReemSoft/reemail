/**
 * MAILMAESTRO_IMAP_SINGLE_CONNECTION — body-part selection tests.
 *
 * `getMessageBody` no longer downloads the full RFC822 source. It picks the
 * display part out of BODYSTRUCTURE and downloads only that. These tests lock
 * the selection rules so attachments never get mistaken for the body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTextPart, collectAttachmentParts } from "../src/imap.js";
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

test("multipart/alternative prefers text/html over text/plain", () => {
  const pick = pickTextPart(alternative);
  assert.equal(pick!.part, "2");
  assert.equal(pick!.type, "text/html");
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
  assert.deepEqual(Object.keys(s.lanes).sort(), ["background", "interactive"]);

  assert.equal(typeof s.openConnections, "number");
  assert.ok(s.idleCloseMs > 0);
  assert.ok(s.listCacheMs > 0);

  // 2. lane counters are non-negative numbers
  for (const v of [s.lanes.interactive, s.lanes.background]) {
    assert.equal(typeof v, "number");
    assert.ok(Number.isFinite(v) && v >= 0);
  }

  // 3. two connections per account max (interactive + background)
  assert.equal(s.maxConnectionsPerAccount, 2);

  // 4. no PII / identifiers among the VALUES: every leaf value is a number,
  //    so no host, account, company, email or any personal identifier can leak.
  const leaves = [s.openConnections, s.maxConnectionsPerAccount, s.idleCloseMs, s.listCacheMs,
    s.lanes.interactive, s.lanes.background];
  for (const v of leaves) assert.equal(typeof v, "number");
  const values = JSON.stringify(s).toLowerCase().replace(/"[a-z]+":/g, "");
  for (const forbidden of ["host", "account", "company", "email", "user", "pass", "@"]) {
    assert.ok(!values.includes(forbidden), `stats must not expose "${forbidden}"`);
  }

  // 5. closing everything zeroes the counters
  await closeAllImapConnections(); // no-op when nothing is open
  const after = imapConnectionStats();
  assert.equal(after.openConnections, 0);
  assert.equal(after.lanes.interactive, 0);
  assert.equal(after.lanes.background, 0);
});
