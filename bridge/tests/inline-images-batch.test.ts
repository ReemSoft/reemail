import assert from "node:assert/strict";
import { test } from "node:test";
import {
  downloadInlinePartsInMailbox,
  planInlineImagesForOpen,
  selectInlineBatchCandidates,
  selectInlineMetadataCandidates,
  visibleMessageAttachments,
  type InlinePartMetadata,
} from "../src/imap.js";

function parts(count: number): InlinePartMetadata[] {
  return Array.from({ length: count }, (_, index) => ({
    cid: `image-${index}`,
    part: String(index + 2),
    mimeType: "image/png",
    size: 4,
  }));
}

function bodyPartsMap(
  query: Array<{ key: string; maxLength: number }>,
  overrides?: { content?: (key: string) => Buffer; mime?: (key: string) => Buffer },
): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  for (const { key } of query) {
    if (key.endsWith(".mime")) {
      const mime = overrides?.mime
        ? overrides.mime(key)
        : Buffer.from("Content-Type: image/png\r\n");
      if (mime) map.set(key, mime);
    } else {
      const content = overrides?.content ? overrides.content(key) : Buffer.from("logo");
      if (content) map.set(key, content);
    }
  }
  return map;
}

function fetchOneClient(
  calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }>,
  overrides?: { content?: (key: string) => Buffer; mime?: (key: string) => Buffer },
): { mailbox: { uidValidity: string }; fetchOne: () => Promise<unknown> } {
  return {
    mailbox: { uidValidity: "77" },
    fetchOne: async (
      range: string,
      query: { bodyParts: Array<{ key: string; maxLength: number }> },
      options: unknown,
    ) => {
      calls.push({ range, bodyParts: query.bodyParts, options });
      return { uid: 42, bodyParts: bodyPartsMap(query.bodyParts, overrides) };
    },
  };
}

test("interactive open with no CID has no inline download work", () => {
  assert.deepEqual(planInlineImagesForOpen([], "interactive"), {
    deferred: [],
    toDownload: [],
  });
});

test("interactive open returns six CID metadata records and downloads none", () => {
  const six = parts(6);
  assert.deepEqual(planInlineImagesForOpen(six, "interactive"), {
    deferred: six,
    toDownload: [],
  });
});

test("CID metadata preserves count, per-image, and total byte limits", () => {
  const candidates = [
    ...parts(20).map((part) => ({ ...part, size: 50 * 1024 })),
    { ...parts(1)[0], cid: "too-many", part: "30", size: 1 },
    { ...parts(1)[0], cid: "too-large", part: "31", size: 256 * 1024 + 1 },
  ];
  const selected = selectInlineBatchCandidates(candidates);
  assert.equal(selected.length, 20);
  assert.equal(
    selected.reduce((sum, part) => sum + part.size, 0),
    1000 * 1024,
  );
  assert.ok(selected.every((part) => part.size <= 256 * 1024));
});

test("interactive metadata retains a 1.8 MiB referenced CID without downloading it", () => {
  const large = {
    cid: "mm-inline-large@mailmaestro",
    part: "2",
    mimeType: "image/png",
    size: Math.round(1.8 * 1024 * 1024),
  };
  const selected = selectInlineMetadataCandidates([large], "inbox");
  assert.deepEqual(selected, [large]);
  assert.deepEqual(planInlineImagesForOpen(selected, "interactive"), {
    deferred: [large],
    toDownload: [],
  });
});

test("referenced deferred CIDs are body resources while a normal PDF remains visible", () => {
  const cid = "mm-inline-large@mailmaestro";
  const smallCid = "logo-small@mailmaestro";
  const attachments = [
    {
      id: "inline",
      part: "2",
      filename: "mm-inline-large.png",
      size: Math.round(1.8 * 1024 * 1024),
      mimeType: "image/png",
      disposition: "inline",
      contentId: `<${cid}>`,
    },
    {
      id: "small-inline",
      part: "2.1",
      filename: "logo.png",
      size: 40 * 1024,
      mimeType: "image/png",
      disposition: "inline",
      contentId: `<${smallCid}>`,
    },
    {
      id: "pdf",
      part: "3",
      filename: "document.pdf",
      size: 1000,
      mimeType: "application/pdf",
      disposition: "attachment",
    },
  ];
  const visible = visibleMessageAttachments(attachments, new Set([cid, smallCid]));
  assert.deepEqual(
    visible.map((attachment) => attachment.id),
    ["pdf"],
  );
  assert.equal(visible.length > 0, true);
  assert.equal(
    visibleMessageAttachments(attachments.slice(0, 2), new Set([cid, smallCid])).length > 0,
    false,
  );
});

test("one multi-part UID FETCH downloads six CID parts with a hard cap on every part", async () => {
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  const client = fetchOneClient(calls);

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 6);
  assert.deepEqual(result.failedCids, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range, "42");
  assert.ok(JSON.stringify(calls[0].options).includes('"uid":true'));
  // Every requested section is a partial with a real transport-level maxLength.
  const requested = calls[0].bodyParts;
  assert.equal(requested.length, 12); // 6 content + 6 .mime sections
  assert.ok(requested.every((part) => typeof part.key === "string" && part.key.length > 0));
  assert.ok(requested.every((part) => Number.isSafeInteger(part.maxLength) && part.maxLength > 0));
  // Content partials are capped at 3x the decoded budget so a legitimate
  // 256KiB image is never truncated even as quoted-printable.
  const content = requested.filter((part) => !part.key.endsWith(".mime"));
  const mime = requested.filter((part) => part.key.endsWith(".mime"));
  assert.equal(content.length, 6);
  assert.equal(mime.length, 6);
  assert.ok(content.every((part) => part.maxLength >= 3 * 256 * 1024));
  // MIME header partials are tightly bounded.
  assert.ok(mime.every((part) => part.maxLength <= 16 * 1024));
  assert.equal("messageFlagsAdd" in client, false);
  assert.equal("messageFlagsSet" in client, false);
});

test("an oversized raw part is rejected fail-closed at the transport cap", async () => {
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  // 786433 raw octets == cap+1: the server answers with a literal at the
  // requested maxLength, which proves the part is oversized/truncated.
  const client = fetchOneClient(calls, {
    content: (key) => (key === "4" ? Buffer.alloc(3 * 256 * 1024 + 1, 0x61) : Buffer.from("logo")),
  });

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 5);
  assert.deepEqual(result.failedCids, ["image-2"]);
  assert.equal(calls.length, 1);
});

test("one missing part fails closed while the other five download", async () => {
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  const client = fetchOneClient(calls, {
    content: (key) => (key === "4" ? undefined : Buffer.from("logo")),
  }) as { mailbox: { uidValidity: string }; fetchOne: () => Promise<unknown> };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 5);
  assert.deepEqual(result.failedCids, ["image-2"]);
});

test("CID batch fails closed before download when UIDVALIDITY changed", async () => {
  let calls = 0;
  const client = {
    mailbox: { uidValidity: "88" },
    async fetchOne() {
      calls += 1;
      throw new Error("must not download a reused UID");
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(2), "77");
  assert.deepEqual(result, { images: [], failedCids: ["image-0", "image-1"] });
  assert.equal(calls, 0);
});

test("ambiguous duplicate Content-ID fails closed without a guess", async () => {
  let calls = 0;
  const client = {
    mailbox: { uidValidity: "77" },
    async fetchOne() {
      calls += 1;
      return {};
    },
  };
  const ambiguous = [
    { cid: "logo", part: "2", mimeType: "image/png", size: 100 },
    { cid: "logo", part: "3", mimeType: "image/png", size: 100 },
  ];
  const result = await downloadInlinePartsInMailbox(client as never, 42, ambiguous, "77");
  assert.deepEqual(result, { images: [], failedCids: ["logo"] });
  assert.equal(calls, 0);
});

test("unknown/zero-size parts fail closed without any FETCH", async () => {
  let calls = 0;
  const client = {
    mailbox: { uidValidity: "77" },
    async fetchOne() {
      calls += 1;
      return {};
    },
  };
  const zeroSized = [{ cid: "zero", part: "2", mimeType: "image/png", size: 0 }];
  const result = await downloadInlinePartsInMailbox(client as never, 42, zeroSized, "77");
  assert.deepEqual(result, { images: [], failedCids: ["zero"] });
  assert.equal(calls, 0);
});

test("per-image byte budget is enforced after decode", async () => {
  const tooBig = Buffer.alloc(256 * 1024 + 1, 0x61);
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  const client = fetchOneClient(calls, {
    content: () => tooBig,
  });

  const three = parts(3).map((part) => ({ ...part, size: 256 * 1024 }));
  const result = await downloadInlinePartsInMailbox(client as never, 42, three, "77");
  assert.equal(result.images.length, 0);
  assert.deepEqual(
    result.failedCids,
    three.map((part) => part.cid),
  );
});

test("base64-encoded parts decode deterministically and bound after decode", async () => {
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  const oversized = Buffer.alloc(300 * 1024, 0x61);
  const client = fetchOneClient(calls, {
    content: (key) =>
      key === "4" ? Buffer.from(oversized.toString("base64")) : Buffer.from("bG9nbw=="),
    mime: () => Buffer.from("Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n"),
  });

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 5);
  assert.deepEqual(result.failedCids, ["image-2"]);
  const logo = result.images[0];
  assert.equal(logo.dataUri, "data:image/png;base64,bG9nbw==");
  assert.equal(logo.size, 4);
});

test("quoted-printable parts decode deterministically", async () => {
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  const client = fetchOneClient(calls, {
    content: (key) => (key === "4" ? Buffer.from("=C3=A9=\r\nx") : Buffer.from("=C3=A9")),
    mime: () =>
      Buffer.from("Content-Type: image/png\r\nContent-Transfer-Encoding: quoted-printable\r\n"),
  });

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 6);
  assert.deepEqual(result.failedCids, []);
  const first = result.images[0];
  assert.equal(first.dataUri, "data:image/png;base64,w6k=");
  assert.equal(first.size, 2);
});

test("declared total byte budget bounds the multi-part FETCH", async () => {
  const calls: Array<{
    range: string;
    bodyParts: Array<{ key: string; maxLength: number }>;
    options: unknown;
  }> = [];
  const client = fetchOneClient(calls, {
    content: () => Buffer.alloc(60 * 1024),
  });
  // Declared 20 x 60KiB = 1.2MiB > 1MiB total budget -> only the first 17
  // (1020KiB) are selected for the single FETCH; the rest fail closed.
  const twenty = parts(20).map((part) => ({ ...part, size: 60 * 1024 }));
  const result = await downloadInlinePartsInMailbox(client as never, 42, twenty, "77");
  assert.equal(result.images.length, 17);
  assert.deepEqual(result.failedCids, ["image-17", "image-18", "image-19"]);
});

test("background prefetch defers every CID part (metadata only)", () => {
  const six = parts(6);
  assert.deepEqual(planInlineImagesForOpen(six, "background"), {
    deferred: six,
    toDownload: [],
  });
});
