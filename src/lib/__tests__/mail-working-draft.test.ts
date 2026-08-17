import { describe, expect, it } from "vitest";
import {
  WORKING_DRAFT_MAX_ATTACHMENT_BYTES,
  emptyWorkingDraftPayload,
  isStaleProviderDraftRow,
  isWorkingDraftAttachmentReference,
  isWorkingDraftPayload,
  type WorkingDraftRecord,
} from "../mail-working-draft";

const attachmentId = "18c561d5-ffae-4ea7-b0f8-b3b6155d6d55";

describe("Working Draft attachment references", () => {
  it("models a 13 MiB upload as a stable reference, not attachment bytes", () => {
    const payload = emptyWorkingDraftPayload();
    payload.attachments.push({
      attachmentId,
      clientKey: "new:normal:4fcd8f36-f302-40cf-9ca4-ffb8ee88a213",
      kind: "attachment",
      filename: "large.pdf",
      mimeType: "application/pdf",
      size: 13 * 1024 * 1024,
      disposition: "attachment",
    });
    expect(isWorkingDraftPayload(payload)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("base64");
    expect(JSON.stringify(payload)).not.toContain("data:");
  });

  it("requires a durable id or the exact provider physical source identity", () => {
    const common = {
      clientKey: "external:normal:1",
      kind: "attachment" as const,
      filename: "same-name.pdf",
      mimeType: "application/pdf",
      size: 42,
    };
    expect(isWorkingDraftAttachmentReference(common)).toBe(false);
    expect(
      isWorkingDraftAttachmentReference({
        ...common,
        source: {
          folderPath: "[Gmail]/Drafts",
          uidValidity: "991",
          uid: 42,
          part: "2.1",
        },
      }),
    ).toBe(true);
  });

  it("does not allow duplicate client keys to make a stale tab ambiguous", () => {
    const one = {
      attachmentId,
      clientKey: "owned:one",
      kind: "attachment" as const,
      filename: "one.txt",
      mimeType: "text/plain",
      size: 1,
    };
    expect(isWorkingDraftPayload({ ...emptyWorkingDraftPayload(), attachments: [one, one] })).toBe(false);
  });

  it("requires CID identity for an inline durable object", () => {
    const inline = {
      attachmentId,
      clientKey: "owned:inline:one",
      kind: "inline-image" as const,
      filename: "mm-inline-one.png",
      mimeType: "image/png",
      size: 12,
      disposition: "inline",
    };
    expect(isWorkingDraftAttachmentReference(inline)).toBe(false);
    expect(isWorkingDraftAttachmentReference({ ...inline, cid: "mm-inline-one@mailmaestro" })).toBe(true);
  });

  it("keeps duplicate filename/MIME provider attachments distinguishable only by exact source", () => {
    const sharedMetadata = {
      kind: "attachment" as const,
      filename: "duplicate.pdf",
      mimeType: "application/pdf",
      size: 42,
    };
    const first = {
      ...sharedMetadata,
      clientKey: "provider-normal:Drafts:7:9:2.1",
      source: { folderPath: "Drafts", uidValidity: "7", uid: 9, part: "2.1" },
    };
    const second = {
      ...sharedMetadata,
      clientKey: "provider-normal:Drafts:7:9:2.2",
      source: { folderPath: "Drafts", uidValidity: "7", uid: 9, part: "2.2" },
    };
    expect(isWorkingDraftAttachmentReference(first)).toBe(true);
    expect(isWorkingDraftAttachmentReference(second)).toBe(true);
    expect(first.source).not.toEqual(second.source);
    expect(
      isWorkingDraftPayload({ ...emptyWorkingDraftPayload(), attachments: [first, second] }),
    ).toBe(true);
  });

  it("enforces the private-object size ceiling before an upload can be referenced", () => {
    expect(
      isWorkingDraftAttachmentReference({
        attachmentId,
        clientKey: "too-large",
        kind: "attachment",
        filename: "too-large.bin",
        mimeType: "application/octet-stream",
        size: WORKING_DRAFT_MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("Draft provider-row reconciliation", () => {
  const record = (serverRefUid: number): WorkingDraftRecord => ({
    draftId: "draft-1",
    revision: 1,
    payload: emptyWorkingDraftPayload(),
    checkpoint: {
      revision: 1,
      state: "checkpointed",
      committedRevision: 1,
      serverRef: {
        folderPath: "[Gmail]/Drafts",
        uid: serverRefUid,
        uidValidity: "42",
      },
    },
    updatedAt: "2026-08-17T00:00:00.000Z",
  });

  it("suppresses a provider row whose UID was replaced by checkpoint B", () => {
    expect(
      isStaleProviderDraftRow({
        draftIdHeader: "draft-1",
        messageUid: 8575,
        messageUidValidity: "42",
        workingDraftRecords: [record(9000)],
      }),
    ).toBe(true);
  });

  it("keeps the current provider row whose UID matches the durable serverRef", () => {
    expect(
      isStaleProviderDraftRow({
        draftIdHeader: "draft-1",
        messageUid: 9000,
        messageUidValidity: "42",
        workingDraftRecords: [record(9000)],
      }),
    ).toBe(false);
  });

  it("does not hide a provider row when there is no durable serverRef yet", () => {
    expect(
      isStaleProviderDraftRow({
        draftIdHeader: "draft-1",
        messageUid: 8575,
        messageUidValidity: "42",
        workingDraftRecords: [{ ...record(9000), checkpoint: { ...record(9000).checkpoint, serverRef: null } }],
      }),
    ).toBe(false);
  });
});
