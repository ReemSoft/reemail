import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  downloadInlinePartsInMailbox,
  planInlineImagesForOpen,
  selectInlineBatchCandidates,
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

test("one mailbox client downloads six CID parts as one batch without flag mutation", async () => {
  const calls: Array<{ uid: string; part: string; options: unknown }> = [];
  const client = {
    download: async (uid: string, part: string, options: unknown) => {
      calls.push({ uid, part, options });
      return {
        content: Readable.from([Buffer.from("logo")]),
        meta: { contentType: "image/png" },
      };
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6));
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
    download: async (_uid: string, part: string) => {
      if (part === "4") throw new Error("missing part");
      return {
        content: Readable.from([Buffer.from("logo")]),
        meta: { contentType: "image/png" },
      };
    },
  };

  const result = await downloadInlinePartsInMailbox(client as never, 42, parts(6));
  assert.equal(result.images.length, 5);
  assert.deepEqual(result.failedCids, ["image-2"]);
});
