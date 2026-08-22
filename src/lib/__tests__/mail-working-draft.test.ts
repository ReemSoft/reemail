import { describe, expect, it } from "vitest";
import {
  WORKING_DRAFT_MAX_ATTACHMENT_BYTES,
  WORKING_DRAFT_MAX_ATTACHMENTS,
  WORKING_DRAFT_MAX_INLINE_IMAGES,
  WORKING_DRAFT_MAX_NORMAL_ATTACHMENTS,
  emptyWorkingDraftPayload,
  filterSentWorkingDraftRecords,
  findWorkingDraftIdByServerRef,
  isSentProviderDraftRef,
  isStaleProviderDraftRow,
  isWorkingDraftAttachmentReference,
  isWorkingDraftPayload,
  projectOwnedWorkingDraftAttachments,
  type WorkingDraftRecord,
} from "../mail-working-draft";

const attachmentId = "18c561d5-ffae-4ea7-b0f8-b3b6155d6d55";

describe("Working Draft attachment references", () => {
  it("projects a materialized provider inline object into a reopenable owned reference", () => {
    const payload = emptyWorkingDraftPayload();
    payload.attachments.push({
      clientKey: "provider-inline:INBOX:42:7:2:photo@example.com",
      kind: "inline-image",
      filename: "mm-inline-photo.jpg",
      mimeType: "image/jpeg",
      size: 8 * 1024 * 1024,
      disposition: "inline",
      cid: "photo@example.com",
      source: { folderPath: "INBOX", uidValidity: "42", uid: 7, part: "2" },
    });
    const record: WorkingDraftRecord = {
      draftId: "draft-1",
      revision: 2,
      payload,
      checkpoint: {
        revision: 2,
        committedRevision: 2,
        state: "checkpointed",
        serverRef: null,
      },
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const projected = projectOwnedWorkingDraftAttachments(record, [
      {
        attachmentId,
        clientKey: payload.attachments[0].clientKey,
        kind: "inline-image",
        filename: "mm-inline-photo.jpg",
        mimeType: "image/jpeg",
        size: 7_500_000,
        disposition: "inline",
        cid: "photo@example.com",
        hasBytes: true,
      },
    ]);

    expect(projected.payload.attachments[0]).toMatchObject({
      attachmentId,
      cid: "photo@example.com",
      size: 7_500_000,
    });
    expect(projected.payload.attachments[0].source).toEqual(payload.attachments[0].source);
    expect(record.payload.attachments[0].attachmentId).toBeUndefined();
  });

  it("does not expose an id before provider bytes exist or across a kind mismatch", () => {
    const payload = emptyWorkingDraftPayload();
    payload.attachments.push({
      clientKey: "provider-inline:one",
      kind: "inline-image",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 100,
      cid: "photo@example.com",
      source: { folderPath: "INBOX", uidValidity: "42", uid: 7, part: "2" },
    });
    const record: WorkingDraftRecord = {
      draftId: "draft-1",
      revision: 1,
      payload,
      checkpoint: {
        revision: 0,
        committedRevision: 0,
        state: "pending",
        serverRef: null,
      },
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const base = {
      attachmentId,
      clientKey: "provider-inline:one",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 100,
      cid: "photo@example.com",
    };
    expect(
      projectOwnedWorkingDraftAttachments(record, [
        { ...base, kind: "inline-image", hasBytes: false },
      ]).payload.attachments[0].attachmentId,
    ).toBeUndefined();
    expect(
      projectOwnedWorkingDraftAttachments(record, [{ ...base, kind: "attachment", hasBytes: true }])
        .payload.attachments[0].attachmentId,
    ).toBeUndefined();
  });

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

  it("enforces the exact 10-normal plus 50-inline transport envelope", () => {
    expect(WORKING_DRAFT_MAX_NORMAL_ATTACHMENTS).toBe(10);
    expect(WORKING_DRAFT_MAX_INLINE_IMAGES).toBe(50);
    expect(WORKING_DRAFT_MAX_ATTACHMENTS).toBe(60);

    const normal = Array.from({ length: 10 }, (_, index) => ({
      clientKey: `provider-normal:${index}`,
      kind: "attachment" as const,
      filename: `file-${index}.pdf`,
      mimeType: "application/pdf",
      size: 1024,
      disposition: "attachment",
      source: {
        folderPath: "INBOX",
        uidValidity: "42",
        uid: 7,
        part: String(index + 1),
      },
    }));

    const inline = Array.from({ length: 50 }, (_, index) => ({
      clientKey: `provider-inline:${index}`,
      kind: "inline-image" as const,
      filename: `image-${index}.png`,
      mimeType: "image/png",
      size: 1024,
      disposition: "inline",
      cid: `image-${index}@example.test`,
      source: {
        folderPath: "INBOX",
        uidValidity: "42",
        uid: 7,
        part: `20.${index + 1}`,
      },
    }));

    const full = {
      ...emptyWorkingDraftPayload(),
      attachments: [...normal, ...inline],
    };

    expect(full.attachments).toHaveLength(60);
    expect(isWorkingDraftPayload(full)).toBe(true);

    const normalOverflow = {
      ...normal[0],
      clientKey: "provider-normal:overflow",
      source: { ...normal[0].source, part: "99" },
    };

    // Still only 60 total, but 11 normal is outside the Bridge contract.
    expect(
      isWorkingDraftPayload({
        ...full,
        attachments: [...normal, normalOverflow, ...inline.slice(0, 49)],
      }),
    ).toBe(false);

    const inlineOverflow = {
      ...inline[0],
      clientKey: "provider-inline:overflow",
      cid: "overflow@example.test",
      source: { ...inline[0].source, part: "20.99" },
    };

    // Still only 60 total, but 51 inline is outside the Bridge contract.
    expect(
      isWorkingDraftPayload({
        ...full,
        attachments: [...normal.slice(0, 9), ...inline, inlineOverflow],
      }),
    ).toBe(false);

    // Aggregate hard ceiling remains enforced too.
    expect(
      isWorkingDraftPayload({
        ...full,
        attachments: [...full.attachments, normalOverflow],
      }),
    ).toBe(false);
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

  it("resolves the stable logical Draft id for a current provider UID", () => {
    expect(
      findWorkingDraftIdByServerRef([record(9000)], "42", 9000),
    ).toBe("draft-1");
  });

  it("does not resolve a stale provider UID to the current logical Draft", () => {
    expect(
      findWorkingDraftIdByServerRef([record(9000)], "42", 8575),
    ).toBeNull();
  });

  it("hides Working Draft rows after durable send success", () => {
    const sent = record(9000);
    const pending = { ...record(9001), draftId: "draft-2" };
    expect(
      filterSentWorkingDraftRecords([sent, pending], new Set(["draft-1"])).map(
        (item) => item.draftId,
      ),
    ).toEqual(["draft-2"]);
  });

  it("suppresses a still-existing provider row for a durably-sent Draft ref", () => {
    expect(
      isSentProviderDraftRef("42", 9000, [
        {
          draftId: "draft-1",
          serverRef: { folderPath: "[Gmail]/Drafts", uid: 9000, uidValidity: "42" },
        },
      ]),
    ).toBe(true);
  });

  it("does not suppress a different provider UID for the sent Draft", () => {
    expect(
      isSentProviderDraftRef("42", 8575, [
        {
          draftId: "draft-1",
          serverRef: { folderPath: "[Gmail]/Drafts", uid: 9000, uidValidity: "42" },
        },
      ]),
    ).toBe(false);
  });
});
