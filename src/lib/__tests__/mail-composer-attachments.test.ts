import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAttachmentTransportPlan,
  buildLocalSourceAttachmentState,
  buildStagedAttachmentTransport,
  deriveAttachmentSourceRef,
  selectNormalComposerAttachments,
  classifyAttachmentLimitExceeded,
  COMPOSE_MAX_TOTAL_BYTES,
  COMPOSE_MAX_NORMAL_ATTACHMENTS,
  COMPOSE_MAX_INLINE_IMAGES,
  COMPOSE_MAX_TOTAL_FILE_PARTS,
  type AttachmentSourceRef,
} from "../mail-composer-attachments";
import {
  createDraftSaver,
  readDraftDoc,
  writeDraftDoc,
  type DraftDocV3,
  type DraftStorageLike,
} from "../mail-draft-lifecycle";
import type { MailAttachment, MailMessage } from "../mail-types";

const sourceRef: AttachmentSourceRef = {
  folderPath: "[Gmail]/Sent Mail",
  uid: 42,
  uidValidity: "777",
};

const normal: MailAttachment[] = [
  { id: "a", part: "2", filename: "a.pdf", size: 10, mimeType: "application/pdf" },
  { id: "b", part: "3", filename: "b.docx", size: 20, mimeType: "application/docx" },
  { id: "c", part: "4", filename: "c.zip", size: 30, mimeType: "application/zip" },
];

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "sent:42",
    threadId: "thread",
    folder: "sent",
    from: { name: "Sender", email: "sender@example.com" },
    to: [],
    subject: "Subject",
    preview: "Preview",
    body: "<p>Body</p>",
    date: "2026-01-01T00:00:00.000Z",
    read: true,
    starred: false,
    hasAttachments: true,
    attachments: normal,
    uidValidity: "777",
    ...overrides,
  };
}

describe("normal Composer attachment selection", () => {
  it("preserves normal metadata while excluding quoted CID body resources", () => {
    const logo: MailAttachment = {
      id: "logo",
      part: "1.2",
      filename: "logo.png",
      size: 5,
      mimeType: "image/png",
      disposition: "inline",
      contentId: "<logo@example>",
    };
    const selected = selectNormalComposerAttachments(
      message({
        body: '<p><img src="cid:logo@example"></p>',
        attachments: [...normal, logo],
        inlineParts: [{ cid: "logo@example", part: "1.2", mimeType: "image/png", size: 5 }],
      }),
    );
    expect(selected).toEqual(normal);
  });

  it("uses the exact resolved physical folder, UID and UIDVALIDITY", () => {
    expect(
      deriveAttachmentSourceRef(message(), {
        sent: "[Gmail]/Sent Mail",
      }),
    ).toEqual(sourceRef);
  });

  it("fails source derivation closed when path, UID or UIDVALIDITY is unsafe", () => {
    expect(deriveAttachmentSourceRef(message(), {})).toBeNull();
    expect(deriveAttachmentSourceRef(message({ id: "sent:nope" }), { sent: "Sent" })).toBeNull();
    expect(
      deriveAttachmentSourceRef(message({ uidValidity: undefined }), { sent: "Sent" }),
    ).toBeNull();
  });

  it("fails source derivation closed for an unknown canonical folder", () => {
    expect(deriveAttachmentSourceRef(message({ id: "unknown:42" }), { sent: "Sent" })).toBeNull();
  });
});

describe("local source attachment fallback", () => {
  function storage(): DraftStorageLike & { rows: Map<string, string> } {
    const rows = new Map<string, string>();
    return {
      rows,
      getItem: (key) => rows.get(key) ?? null,
      setItem: (key, value) => void rows.set(key, value),
      removeItem: (key) => void rows.delete(key),
    };
  }

  function sourceState(attachments: MailAttachment[], preserved = new Map<string, string>()) {
    return buildLocalSourceAttachmentState({
      attachments,
      restoredHandles: new Map(),
      preservedHandles: preserved,
      sourceRef,
    });
  }

  it("persists all source metadata before remote success and round-trips a local-only draft", () => {
    const state = sourceState(normal);
    const store = storage();
    const doc: DraftDocV3 = {
      version: 3,
      draftId: "local-reply",
      snapshot: {
        to: [],
        cc: [],
        bcc: [],
        subject: "reply",
        html: "<p>body</p>",
        showCc: false,
        showBcc: false,
        sourceAttachments: state,
      },
      serverRef: null,
      updatedAt: 1,
    };
    expect(writeDraftDoc(store, "sender@example.com", doc)).toBe(true);
    const restored = readDraftDoc(store, "sender@example.com")?.snapshot.sourceAttachments;
    expect(restored).toEqual({
      sourceRef,
      attachments: normal.map((attachment) => ({
        id: attachment.id,
        part: attachment.part,
        filename: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })),
    });
    const raw = [...store.rows.values()].join("");
    expect(raw).not.toMatch(/base64|data:|blob:/i);
  });

  it("keeps source metadata restorable after a NETWORK failed result", async () => {
    const store = storage();
    const sourceAttachments = sourceState(normal);
    const snapshot = {
      to: [],
      cc: [],
      bcc: [],
      subject: "forward",
      html: "<p>body</p>",
      showCc: false,
      showBcc: false,
      sourceAttachments,
    };
    expect(
      writeDraftDoc(store, "sender@example.com", {
        version: 3,
        draftId: "local-forward",
        snapshot,
        serverRef: null,
        updatedAt: 1,
      }),
    ).toBe(true);
    const saver = createDraftSaver("local-forward", {
      saveRemote: async () => ({ ok: false, code: "NETWORK" }),
    });
    await saver.requestSave(snapshot, null, 1);
    expect(saver.getStatus()).toBe("failed");
    expect(
      readDraftDoc(store, "sender@example.com")?.snapshot.sourceAttachments?.attachments.map(
        ({ id }) => id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("removing before or after a local write does not restore the removed source", () => {
    expect(sourceState([normal[0], normal[2]])?.attachments.map(({ id }) => id)).toEqual([
      "a",
      "c",
    ]);
    const first = sourceState(normal);
    expect(first?.attachments.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    const next = sourceState([normal[0], normal[2]]);
    expect(next?.attachments.map(({ id }) => id)).toEqual(["a", "c"]);
  });

  it("moves preserved attachments to handles without duplicate local source metadata", () => {
    const preserved = new Map([
      ["a", "handle-a"],
      ["b", "handle-b"],
      ["c", "handle-c"],
    ]);
    expect(sourceState(normal, preserved)).toBeUndefined();
    const plan = buildAttachmentTransportPlan({
      attachments: normal,
      restoredHandles: new Map(),
      preservedHandles: preserved,
      sourceRef,
    });
    expect(plan.attachmentHandles).toEqual(["handle-a", "handle-b", "handle-c"]);
    expect(plan.sourceAttachments).toEqual([]);
  });

  it("supports mixed restored and source metadata with one transport per attachment", () => {
    const staged = { id: "staged:0", filename: "new.txt", size: 4, mimeType: "text/plain" };
    const plan = buildAttachmentTransportPlan({
      attachments: [normal[0], staged, normal[2]],
      restoredHandles: new Map([["staged:0", "uploaded-handle"]]),
      preservedHandles: new Map([["a", "preserved-a"]]),
      sourceRef,
    });
    expect(plan.attachmentHandles).toEqual(["preserved-a", "uploaded-handle"]);
    expect(plan.sourceAttachmentIds).toEqual(["c"]);
    expect(plan.unresolvedAttachmentIds).toEqual([]);
  });
});

describe("per-attachment transport planning", () => {
  it("immediate send/save references every kept source without fake handles", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: normal,
      restoredHandles: new Map(),
      preservedHandles: new Map(),
      sourceRef,
    });
    expect(plan.attachmentHandles).toEqual([]);
    expect(plan.sourceAttachmentIds).toEqual(["a", "b", "c"]);
    expect(plan.sourceAttachments.map((source) => source.part)).toEqual(["2", "3", "4"]);
    expect(
      plan.sourceAttachments.every((source) => source.folderPath === sourceRef.folderPath),
    ).toBe(true);
    expect(plan.unresolvedAttachmentIds).toEqual([]);
  });

  it("reuses preserved handles per stable attachment id", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: normal,
      restoredHandles: new Map(),
      preservedHandles: new Map([
        ["a", "handle-a"],
        ["b", "handle-b"],
        ["c", "handle-c"],
      ]),
      sourceRef,
    });
    expect(plan.attachmentHandles).toEqual(["handle-a", "handle-b", "handle-c"]);
    expect(plan.sourceAttachments).toEqual([]);
  });

  it("removing the middle attachment before first save keeps only first and third sources", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: [normal[0], normal[2]],
      restoredHandles: new Map(),
      preservedHandles: new Map(),
      sourceRef,
    });
    expect(plan.sourceAttachmentIds).toEqual(["a", "c"]);
    expect(plan.sourceAttachments.map((source) => source.part)).toEqual(["2", "4"]);
  });

  it("removing an attachment after preserve excludes its handle", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: [normal[0], normal[2]],
      restoredHandles: new Map(),
      preservedHandles: new Map([
        ["a", "handle-a"],
        ["b", "removed-handle-b"],
        ["c", "handle-c"],
      ]),
      sourceRef,
    });
    expect(plan.attachmentHandles).toEqual(["handle-a", "handle-c"]);
    expect(plan.attachmentHandles).not.toContain("removed-handle-b");
  });

  it("removing all produces no handles and no source entries", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: [],
      restoredHandles: new Map([["a", "stale-restored"]]),
      preservedHandles: new Map([["b", "stale-preserved"]]),
      sourceRef,
    });
    expect(plan).toEqual({
      attachmentHandles: [],
      sourceAttachments: [],
      sourceAttachmentIds: [],
      unresolvedAttachmentIds: [],
    });
  });

  it("supports restored + preserved + source in one plan without duplicates", () => {
    const attachments = [
      ...normal,
      { id: "d", part: "5", filename: "d.txt", size: 40, mimeType: "text/plain" },
    ];
    const plan = buildAttachmentTransportPlan({
      attachments,
      restoredHandles: new Map([["a", "restored-a"]]),
      preservedHandles: new Map([["b", "preserved-b"]]),
      sourceRef,
    });
    expect(plan.attachmentHandles).toEqual(["restored-a", "preserved-b"]);
    expect(plan.sourceAttachmentIds).toEqual(["c", "d"]);
    expect(plan.sourceAttachments.map((source) => source.part)).toEqual(["4", "5"]);
  });

  it("reports missing source or invalid parts as unresolved instead of dropping them", () => {
    const invalid = { ...normal[0], part: "not-a-part" };
    expect(
      buildAttachmentTransportPlan({
        attachments: [invalid, normal[1]],
        restoredHandles: new Map(),
        preservedHandles: new Map(),
        sourceRef: null,
      }).unresolvedAttachmentIds,
    ).toEqual(["a", "b"]);
  });
});

describe("Reply, Reply All, Forward and Composer wiring", () => {
  const route = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

  it("REPLY_ORIGINAL_ATTACHMENT_NOT_INHERITED and REPLY_ALL_ORIGINAL_ATTACHMENT_NOT_INHERITED", () => {
    const builders = route.slice(
      route.indexOf("function buildReply"),
      route.indexOf("type SortOption"),
    );
    const reply = builders.slice(0, builders.indexOf("function buildForward"));
    expect(reply).not.toContain("selectNormalComposerAttachments(message)");
    expect(reply).not.toContain("existingAttachments:");
    expect(reply).not.toContain("attachmentSourceRef:");
    expect(reply).toContain("const recipients = buildReplyRecipients(message, myEmail, all)");

    expect(builders.match(/selectNormalComposerAttachments\(message\)/g)).toHaveLength(2);
    expect(builders.match(/existingAttachments:/g)).toHaveLength(1);
    expect(builders).toContain("const existingAttachments =");
  });

  it("keeps an attachment-free original reply normal", () => {
    const reply = route.slice(
      route.indexOf("function buildReply"),
      route.indexOf("function buildForward"),
    );
    expect(reply).not.toContain("message.attachments");
    expect(reply).toContain("bodyIsHtml: true");
    expect(reply).toContain("...threading");
  });

  it("REPLY_NEW_ATTACHMENT_SENT and REPLY_SEND_PAYLOAD_EXCLUDES_ORIGINAL", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: [],
      restoredHandles: new Map(),
      preservedHandles: new Map(),
      sourceRef: null,
    });
    const transport = buildStagedAttachmentTransport({
      plan,
      normal: [
        {
          handle: "reply-pdf-handle",
          filename: "reply.pdf",
          size: 100,
          mimeType: "application/pdf",
          kind: "attachment",
          expiresAt: 1,
        },
      ],
      inline: [],
      inlineMetadata: [],
    });
    expect(transport).toEqual({
      attachmentHandles: ["reply-pdf-handle"],
      stagedInlineImages: [],
      sourceAttachments: [],
    });
  });

  it("ORIGINAL_MESSAGE_ATTACHMENT_PRESERVED and HISTORICAL_MESSAGE_ATTACHMENT_PRESERVED", () => {
    expect(selectNormalComposerAttachments(message({ attachments: [normal[0]] }))).toEqual([
      normal[0],
    ]);
    expect(route).toContain("<MessageAttachmentsSection message={message} />");
    expect(route).toContain("afterLatest={<MessageAttachmentsSection message={loaded} />}");
  });

  it("DRAFT_ATTACHMENT_PRESERVED and DRAFT_ATTACHMENT_NOT_LEAKED_TO_NEW_REPLY", () => {
    const builders = route.slice(
      route.indexOf("function buildReply"),
      route.indexOf("type SortOption"),
    );
    const reply = builders.slice(0, builders.indexOf("function buildForward"));
    const draft = builders.slice(builders.indexOf("function buildEditDraft"));
    expect(reply).not.toContain("existingAttachments");
    expect(draft).toContain("const existingAttachments =");
    expect(draft).toContain("existingAttachments,");
  });

  it("REPLY_A_TO_REPLY_B_NO_LEAK and Reply to Reply All has no source leakage", () => {
    const emptyReplyPlan = () =>
      buildAttachmentTransportPlan({
        attachments: [],
        restoredHandles: new Map([["draft", "stale-draft-handle"]]),
        preservedHandles: new Map([["reply-a", "stale-reply-a-handle"]]),
        sourceRef,
      });
    expect(emptyReplyPlan()).toEqual({
      attachmentHandles: [],
      sourceAttachments: [],
      sourceAttachmentIds: [],
      unresolvedAttachmentIds: [],
    });
    expect(emptyReplyPlan()).toEqual(emptyReplyPlan());
  });

  it("initializes existingKept from metadata and performs no normal-byte hydration on mount", () => {
    const initialization = route.slice(
      route.indexOf("const restoredStaged"),
      route.indexOf("const [files, setFiles]"),
    );
    expect(initialization).toContain("initial?.existingAttachments?.attachments ?? []");
    expect(initialization).not.toMatch(/blob\(|arrayBuffer\(|downloadAttachment|new File/);
  });

  it("keeps attachmentSourceRef separate from Draft previousRef", () => {
    expect(route).toContain("attachmentSourceRef?: AttachmentSourceRef");
    expect(route).toContain("initial?.attachmentSourceRef ?? restoredSource?.sourceRef ?? null");
    expect(route).not.toContain("sourcePreviousRef");
  });

  it("maps returned source handles by stable id and filters removed handles", () => {
    expect(route).toContain("attachmentPlan.sourceAttachmentIds.forEach((attachmentId, index)");
    expect(route).toContain("preservedSourceHandlesRef.current.set(attachmentId, handle)");
    expect(route).not.toContain("...preservedSourceHandlesRef.current.values()");
    expect(route).not.toContain("preservedSourceHandlesRef.current.size ||");
  });

  it("attachment mention and limits use separate normal and inline counts", () => {
    expect(route).toContain("existingKept.length + files.length === 0");
    expect(route).toContain("const normalAttachmentCount = files.length + existingKept.length");
    expect(route).toContain("const inlineImageCount = inlineImages.length");
    expect(route).toContain("const totalBytes =");
    expect(route).not.toContain(
      "const totalCount = files.length + existingKept.length + inlineImages.length",
    );
  });

  it("hard size guard counts only locally-known bytes, never BODYSTRUCTURE metadata", () => {
    const sizeTotal = route.slice(
      route.indexOf("const inlineBytes"),
      route.indexOf("const normalAttachmentCount"),
    );
    expect(sizeTotal).toContain("files.reduce((acc, f) => acc + f.size, 0)");
    expect(sizeTotal).toContain("image.file.size");
    expect(sizeTotal).not.toContain("existingKept");
    expect(route).not.toContain(
      "files.reduce((acc, f) => acc + f.size, 0) + existingBytes + inlineBytes",
    );
  });

  it("autosave size validation excludes unreliable BODYSTRUCTURE metadata", () => {
    const saveRemoteSize = route.slice(
      route.indexOf("const totalAttachmentBytes"),
      route.indexOf("const stagedFiles"),
    );
    expect(saveRemoteSize).toContain("currentFiles.reduce((sum, file) => sum + file.size, 0)");
    expect(saveRemoteSize).toContain(
      "transportImages.reduce((sum, image) => sum + image.file.size, 0)",
    );
    expect(saveRemoteSize).not.toContain("keptBytes");
  });

  it("surfaces Bridge attachment-size rejections with the clear local message", () => {
    expect(route).toContain("isAttachmentSizeLimitError(result.error)");
    expect(route).toContain('tr("تجاوزت حدود المرفقات المسموحة")');
  });

  it("persists and restores local source metadata without byte hydration", () => {
    expect(route).toContain("const restoredSource = restored?.sourceAttachments");
    expect(route).toContain("...(restoredSource?.attachments ?? [])");
    expect(route).toContain("restoredSource?.sourceRef ?? null");
    expect(route).toContain("sourceAttachments: buildLocalSourceAttachmentState({");
  });

  it("keeps Ctrl/Cmd+Enter attachment limits and mention state current", () => {
    expect(route).toMatch(
      /\[\s*to,\s*cc,\s*bcc,\s*subject,\s*files,\s*existingKept,\s*inlineImages,\s*normalAttachmentCount,\s*inlineImageCount,\s*totalBytes,?\s*\]/,
    );
    expect(route).toContain("existingKept.length + files.length === 0");
  });

  it("combines current source handles with newly uploaded staged handles", () => {
    expect(route.match(/buildStagedAttachmentTransport\(\{/g)).toHaveLength(2);
    expect(route.match(/\.\.\.attachmentTransport/g)).toHaveLength(2);
  });

  it("FORWARD_BEHAVIOR_UNCHANGED: keeps its normal source separate from a hydrated inline CID", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: [normal[0]],
      restoredHandles: new Map(),
      preservedHandles: new Map(),
      sourceRef,
    });
    const transport = buildStagedAttachmentTransport({
      plan,
      normal: [],
      inline: [
        {
          handle: "inline-handle",
          filename: "mm-inline-cid.png",
          size: 1,
          mimeType: "image/png",
          kind: "inline-image",
          expiresAt: 1,
        },
      ],
      inlineMetadata: [
        {
          uploadFilename: "mm-inline-cid.png",
          cid: "quoted-cid@example",
          contentType: "image/png",
        },
      ],
    });

    expect(transport.sourceAttachments).toHaveLength(1);
    expect(transport.sourceAttachments[0].part).toBe("2");
    expect(transport.attachmentHandles).toEqual([]);
    expect(transport.stagedInlineImages).toEqual([
      {
        handle: "inline-handle",
        uploadFilename: "mm-inline-cid.png",
        cid: "quoted-cid@example",
        contentType: "image/png",
      },
    ]);
  });

  it("fails closed before Send V2 when a staged result crosses transport buckets", () => {
    const plan = buildAttachmentTransportPlan({
      attachments: [],
      restoredHandles: new Map(),
      preservedHandles: new Map(),
      sourceRef: null,
    });
    const wrong = {
      handle: "wrong",
      filename: "x.png",
      size: 1,
      mimeType: "image/png",
      kind: "inline-image" as const,
      expiresAt: 1,
    };
    expect(() =>
      buildStagedAttachmentTransport({ plan, normal: [wrong], inline: [], inlineMetadata: [] }),
    ).toThrow("NORMAL_ATTACHMENT_KIND_MISMATCH");
  });

  it("separates normal and inline resource classes in every hard-count guard", () => {
    expect(route).toContain("const normalAttachmentCount = files.length + existingKept.length");
    expect(route).toContain("const inlineImageCount = inlineImages.length");
    expect(route).toContain('tr("الحد الأقصى للمرفقات هو 10 ملفات")');
    expect(route).toContain('tr("تجاوزت الرسالة الحد المسموح للصور المضمنة")');
    expect(route).toContain('exceeded === "bytes"');
    expect(route).not.toContain(
      "const totalCount = files.length + existingKept.length + inlineImages.length",
    );
    expect(route).not.toContain("totalCount > COMPOSE_MAX_FILES");
  });

  it("normal attachment adding is gated only by the normal 10-cap, never by inline images", () => {
    const addFiles = route.slice(
      route.indexOf("function addFiles"),
      route.indexOf("function removeExistingAttachment"),
    );
    expect(addFiles).toContain("runningNormal >= COMPOSE_MAX_NORMAL_ATTACHMENTS");
    expect(addFiles).toContain('tr("الحد الأقصى للمرفقات هو 10 ملفات")');
    expect(addFiles).not.toContain("inlineImageCount");
  });

  it("inline image insertion is gated only by the inline 20-cap, never by normal attachments", () => {
    expect(route).toContain("inlineImageCount + added.length > COMPOSE_MAX_INLINE_IMAGES");
    expect(route).toContain('tr("تجاوزت الرسالة الحد المسموح للصور المضمنة")');
    expect(route).not.toContain("totalCount + added.length >= COMPOSE_MAX_FILES");
  });

  it("attach button disable follows the normal class only, inline images never disable it", () => {
    expect(route).toContain(
      "disabled={sending || normalAttachmentCount >= COMPOSE_MAX_NORMAL_ATTACHMENTS}",
    );
    expect(route).not.toContain("disabled={sending || totalCount >= COMPOSE_MAX_FILES}");
  });

  it("saveRemote/autosave enforces the same split with transportImages for the inline class", () => {
    const saveRemote = route.slice(
      route.indexOf("const totalAttachmentBytes"),
      route.indexOf("const stagedFiles"),
    );
    expect(saveRemote).toContain(
      "const normalParts = existingKeptRef.current.length + currentFiles.length",
    );
    expect(saveRemote).toContain("const inlineParts = transportImages.length");
    expect(saveRemote).toContain("classifyAttachmentLimitExceeded({");
    expect(saveRemote).not.toContain(
      "existingKeptRef.current.length + currentFiles.length + transportImages.length",
    );
  });
});

describe("classifyAttachmentLimitExceeded resource-class model", () => {
  it("allows 4 existing normal attachments + 7 inline images", () => {
    expect(
      classifyAttachmentLimitExceeded({
        normalAttachmentCount: 4,
        inlineImageCount: 7,
        totalBytes: 1,
      }),
    ).toBeNull();
  });

  it("allows exactly 10 normal + 20 inline images", () => {
    expect(
      classifyAttachmentLimitExceeded({
        normalAttachmentCount: 10,
        inlineImageCount: 20,
        totalBytes: 1,
      }),
    ).toBeNull();
  });

  it("rejects 11 normal attachments with 0 inline images", () => {
    expect(
      classifyAttachmentLimitExceeded({
        normalAttachmentCount: 11,
        inlineImageCount: 0,
        totalBytes: 1,
      }),
    ).toBe("normal");
  });

  it("rejects 4 normal attachments + 21 inline images", () => {
    expect(
      classifyAttachmentLimitExceeded({
        normalAttachmentCount: 4,
        inlineImageCount: 21,
        totalBytes: 1,
      }),
    ).toBe("inline");
  });

  it("rejects the shared byte budget beyond 25 MiB with inline bytes included", () => {
    expect(
      classifyAttachmentLimitExceeded({
        normalAttachmentCount: 1,
        inlineImageCount: 1,
        totalBytes: COMPOSE_MAX_TOTAL_BYTES + 1,
      }),
    ).toBe("bytes");
    expect(
      classifyAttachmentLimitExceeded({
        normalAttachmentCount: 1,
        inlineImageCount: 1,
        totalBytes: COMPOSE_MAX_TOTAL_BYTES,
      }),
    ).toBeNull();
  });

  it("pins the resource-class constants to the approved model", () => {
    expect(COMPOSE_MAX_NORMAL_ATTACHMENTS).toBe(10);
    expect(COMPOSE_MAX_INLINE_IMAGES).toBe(20);
    expect(COMPOSE_MAX_TOTAL_FILE_PARTS).toBe(30);
    expect(COMPOSE_MAX_TOTAL_BYTES).toBe(25 * 1024 * 1024);
  });
});
