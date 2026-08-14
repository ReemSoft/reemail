import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("lightning message-open Bridge boundaries", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const imap = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");

  it("exposes exactly one bounded background prefetch endpoint", () => {
    assert.equal((index.match(/"\/api\/messages-prefetch"/g) ?? []).length, 1);
    assert.match(index, /MessagePrefetchPayloadSchema[\s\S]*?\.max\(12\)/);
    assert.match(index, /imapGates\.acquire\([\s\S]*?priority: "background"/);
    assert.match(index, /finally \{[\s\S]*?release\(\)/);
    assert.match(imap, /getMessageBodiesBatch[\s\S]*?slice\(0, 12\)/);
    assert.match(imap, /getMessageBody\(account, password, folder, uid, "background"\)/);
  });

  it("downloads a CID batch under one mailbox scope and preserves UIDVALIDITY", () => {
    const batch = imap.slice(
      imap.indexOf("export async function getLargeInlinePartsBatch"),
      imap.indexOf("export interface LargeInlinePartDependencies"),
    );
    assert.equal((batch.match(/withAccountMailbox\(/g) ?? []).length, 1);
    assert.match(batch, /String\(mailbox\.uidValidity\) !== expectedUidValidity/);
    assert.match(batch, /downloadPartBuffer\(/);
    assert.match(batch, /failedCids\.push\(part\.cid\)/);
    assert.doesNotMatch(batch, /markRead|messageFlagsAdd|messageFlagsRemove/);
    assert.equal((index.match(/"\/api\/message-inline-parts"/g) ?? []).length, 1);
  });

  it("fetches the small inline batch with ONE multi-part FETCH and defers on background", () => {
    const body = imap.slice(
      imap.indexOf("export async function getMessageBody("),
      imap.indexOf("export async function getMessageBodiesBatch("),
    );
    assert.match(body, /planInlineImagesForOpen\(metadataCandidates, lane\)/);
    assert.doesNotMatch(body, /toDownload: candidates/);
    const inline = imap.slice(
      imap.indexOf("export async function downloadInlinePartsInMailbox("),
      imap.indexOf("export async function getInlineImagesBatch("),
    );
    assert.equal((inline.match(/fetchOne\(/g) ?? []).length, 1);
    assert.doesNotMatch(inline, /downloadMany/);
    assert.match(inline, /maxLength/);
    assert.match(inline, /INLINE_IMAGE_ENCODED_MAX_BYTES \+ 1/);
    assert.doesNotMatch(inline, /messageFlagsAdd|messageFlagsRemove|markRead/);
  });
});
