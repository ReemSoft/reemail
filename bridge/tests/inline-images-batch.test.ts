import { Readable } from "node:stream";
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

test("one mailbox client downloads six CID parts as one batch without flag mutation", async () => {
  const calls: Array<{ uid: string; part: string; options: unknown }> = [];
  const client = {
    mailbox: { uidValidity: "77" },
    download: async (uid: string, part: string, options: unknown) => {
      calls.push({ uid, part, options });
      return {
        content: Readable.from([Buffer.from("logo")]),
        meta: { contentType: "image/png" },
      };
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 6);
  assert.deepEqual(result.failedCids, []);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.uid === "42"));
  assert.ok(calls.every((call) => JSON.stringify(call.options).includes('"uid":true')));
  assert.equal("messageFlagsAdd" in client, false);
  assert.equal("messageFlagsSet" in client, false);
});

test("one failed image does not fail the other five", async () => {
  const client = {
    mailbox: { uidValidity: "77" },
    download: async (_uid: string, part: string) => {
      if (part === "4") throw new Error("missing part");
      return {
        content: Readable.from([Buffer.from("logo")]),
        meta: { contentType: "image/png" },
      };
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6), "77");
  assert.equal(result.images.length, 5);
  assert.deepEqual(result.failedCids, ["image-2"]);
});

test("CID batch fails closed before download when UIDVALIDITY changed", async () => {
  let downloads = 0;
  const client = {
    mailbox: { uidValidity: "88" },
    async download() {
      downloads += 1;
      throw new Error("must not download a reused UID");
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(2), "77");
  assert.deepEqual(result, { images: [], failedCids: ["image-0", "image-1"] });
  assert.equal(downloads, 0);
});
