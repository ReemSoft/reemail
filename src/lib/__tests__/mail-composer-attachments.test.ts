import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAttachmentTransportPlan,
  buildLocalSourceAttachmentState,
  deriveAttachmentSourceRef,
  selectNormalComposerAttachments,
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

  it("keeps source metadata restorable after a NETWORK saved-local result", async () => {
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
    expect(saver.getStatus()).toBe("saved-local");
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

  it("uses one normal-attachment rule for Reply/Reply All, Forward and Edit Draft", () => {
    const builders = route.slice(
      route.indexOf("function buildReply"),
      route.indexOf("type SortOption"),
    );
    expect(builders.match(/selectNormalComposerAttachments\(message\)/g)).toHaveLength(3);
    expect(builders).toContain(
      "if (normalAttachments.length > 0 && !attachmentSourceRef) return null",
    );
    expect(builders.match(/existingAttachments:/g)).toHaveLength(2);
    expect(builders).toContain("const existingAttachments =");
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

  it("attachment mention and limits include retained existing attachments", () => {
    expect(route).toContain("existingKept.length + files.length === 0");
    expect(route).toContain(
      "const totalCount = files.length + existingKept.length + inlineImages.length",
    );
    expect(route).toContain("const totalBytes =");
  });

  it("persists and restores local source metadata without byte hydration", () => {
    expect(route).toContain("const restoredSource = restored?.sourceAttachments");
    expect(route).toContain("...(restoredSource?.attachments ?? [])");
    expect(route).toContain("restoredSource?.sourceRef ?? null");
    expect(route).toContain("sourceAttachments: buildLocalSourceAttachmentState({");
  });

  it("keeps Ctrl/Cmd+Enter attachment limits and mention state current", () => {
    expect(route).toContain(
      "[to, cc, bcc, subject, files, existingKept, inlineImages, totalCount, totalBytes]",
    );
    expect(route).toContain("existingKept.length + files.length === 0");
  });

  it("combines current source handles with newly uploaded staged handles", () => {
    expect(route).toContain("...attachmentPlan.attachmentHandles");
    expect(route).toContain("...stagedNormal.map((item) => item.handle)");
    expect(route).toContain("...stagedFiles.map((item) => item.handle)");
  });
});
