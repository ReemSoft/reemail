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

test("one multi-part UID FETCH downloads six CID parts without flag mutation", async () => {
  const calls: Array<{ range: string; parts: string[]; options: unknown }> = [];
  const client = {
    mailbox: { uidValidity: "77" },
    downloadMany: async (range: string, parts: string[], options: unknown) => {
      calls.push({ range, parts, options });
      const data: Record<string, { content: Buffer; meta: { contentType: string } }> = {};
      for (const part of parts) {
        data[part] = { content: Buffer.from("logo"), meta: { contentType: "image/png" } };
      }
      return data;
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 6);
  assert.deepEqual(result.failedCids, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range, "42");
  assert.deepEqual(calls[0].parts, ["2", "3", "4", "5", "6", "7"]);
  assert.ok(JSON.stringify(calls[0].options).includes('"uid":true'));
  assert.equal("messageFlagsAdd" in client, false);
  assert.equal("messageFlagsSet" in client, false);
});

test("one missing part fails closed while the other five download", async () => {
  const client = {
    mailbox: { uidValidity: "77" },
    downloadMany: async (_range: string, parts: string[]) => {
      const data: Record<string, { content: Buffer; meta: { contentType: string } }> = {};
      for (const part of parts) {
        if (part === "4") continue; // a missing part is simply omitted
        data[part] = { content: Buffer.from("logo"), meta: { contentType: "image/png" } };
      }
      return data;
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 5);
  assert.deepEqual(result.failedCids, ["image-2"]);
});

test("CID batch fails closed before download when UIDVALIDITY changed", async () => {
  let calls = 0;
  const client = {
    mailbox: { uidValidity: "88" },
    async downloadMany() {
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
    async downloadMany() {
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
    async downloadMany() {
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
  const client = {
    mailbox: { uidValidity: "77" },
    downloadMany: async (_range: string, parts: string[]) => {
      const data: Record<string, { content: Buffer; meta: { contentType: string } }> = {};
      for (const part of parts) {
        data[part] = { content: tooBig, meta: { contentType: "image/png" } };
      }
      return data;
    },
  };
  const three = parts(3).map((part) => ({ ...part, size: 256 * 1024 }));
  const result = await downloadInlinePartsInMailbox(client as never, 42, three, "77");
  assert.equal(result.images.length, 0);
  assert.deepEqual(
    result.failedCids,
    three.map((part) => part.cid),
  );
});

test("declared total byte budget bounds the multi-part FETCH", async () => {
  const client = {
    mailbox: { uidValidity: "77" },
    downloadMany: async (_range: string, parts: string[]) => {
      const data: Record<string, { content: Buffer; meta: { contentType: string } }> = {};
      for (const part of parts) {
        data[part] = { content: Buffer.alloc(60 * 1024), meta: { contentType: "image/png" } };
      }
      return data;
    },
  };
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
