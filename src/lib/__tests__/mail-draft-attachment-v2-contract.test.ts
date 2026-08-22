import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readDraftDoc, writeDraftDoc, type DraftDocV3 } from "../mail-draft-lifecycle";

describe("draft attachment V2 contract", () => {
  const composer = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
  const workingDraftServer = readFileSync(
    new URL("../mail-working-draft.server.ts", import.meta.url),
    "utf8",
  );

  it("reuses one staged upload and sends no attachment bytes on autosave", () => {
    expect(composer).toContain("getOrCreateStagedUpload(stagedUploadsRef.current");
    expect(composer).toContain('fetch("/api/mail-draft-save-v2"');
    expect(composer).toContain("sourceAttachments");
    expect(composer).toContain("DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS");
    expect(composer).toContain("scheduleWorkingDraftCheckpoint(hasAttachments");
    const remoteSave = composer.slice(
      composer.indexOf("saveRemote: async"),
      composer.indexOf("onStatus: setSaveStatus"),
    );
    expect(remoteSave).not.toContain("new FormData");
    expect(remoteSave).not.toContain("res.blob()");
  });

  it("persists handles as small snapshot metadata", () => {
    const rows = new Map<string, string>();
    const storage = {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => void rows.set(key, value),
      removeItem: (key: string) => void rows.delete(key),
    };
    const doc: DraftDocV3 = {
      version: 3,
      draftId: "11111111-2222-4333-8444-555555555555",
      snapshot: {
        to: [],
        cc: [],
        bcc: [],
        subject: "draft",
        html: "<p>body</p>",
        showCc: false,
        showBcc: false,
        stagedAttachments: [
          {
            handle: "encrypted-handle",
            filename: "large.pdf",
            size: 20 * 1024 * 1024,
            mimeType: "application/pdf",
          },
        ],
      },
      serverRef: null,
      updatedAt: 1,
    };
    expect(writeDraftDoc(storage, "a@example.com", doc)).toBe(true);
    expect(readDraftDoc(storage, "a@example.com")?.snapshot.stagedAttachments).toEqual(
      doc.snapshot.stagedAttachments,
    );
    expect([...rows.values()].join()).not.toContain("base64");
  });

  it("adopts an imported clientKey row without weakening its ownership scope", () => {
    expect(workingDraftServer).not.toContain(
      'if (current?.storage_path) throw new Error("ATTACHMENT_ID_REQUIRED")',
    );
    const adoption = workingDraftServer.slice(
      workingDraftServer.indexOf("if (current?.storage_path)"),
      workingDraftServer.indexOf(
        'if (!reference.source) throw new Error("ATTACHMENT_SOURCE_REQUIRED")',
      ),
    );
    expect(adoption).toContain("if (current.kind !== reference.kind)");
    expect(adoption).toContain('.eq("draft_id", draftId)');
    expect(adoption).toContain('.eq("company_id", auth.companyId)');
    expect(adoption).toContain('.eq("account_id", auth.accountId)');
    expect(adoption).toContain("retainedIds.add(current.id)");
  });

  it("sends trustworthy provider attachments and quoted inline sources directly", () => {
    expect(workingDraftServer).toContain("async function resolveSendAttachments(");
    expect(workingDraftServer).toContain(
      "if (row.storage_path) return { owned: row, source: null, inlineSource: null }",
    );
    expect(workingDraftServer).toContain('if (row.kind === "attachment" && source)');
    expect(workingDraftServer).toContain('if (row.kind === "inline-image" && source && row.cid)');
    expect(workingDraftServer).toContain("workingDraftInlineUploadFilename(row)");
    expect(workingDraftServer).toContain("sourceInlineImages: input.sourceInlineImages ?? []");
    expect(workingDraftServer).toContain("sourceInlineImages: plan.inlineSources");
    expect(workingDraftServer).toContain(
      "owned: await importExternalAttachment(auth, row, context)",
    );
    expect(workingDraftServer).toContain("WORKING_DRAFT_STAGE_CONCURRENCY");
    expect(workingDraftServer).toContain("sourceAttachments: input.sourceAttachments ?? []");
    expect(workingDraftServer).toContain("sourceAttachments: plan.sources");
    expect(workingDraftServer).toContain('/api/remote-attachment-stage');
    expect(workingDraftServer).toContain("createSignedUrl(row.storage_path, 120)");
    expect(workingDraftServer).toContain("Compatibility/reachability fallback");
  });

  it("uses a bilingual staged progress panel and visibly completes at 100%", () => {
    expect(composer).not.toContain("startSendFlight");
    expect(composer).toContain("function SendProgressPanel(");
    expect(composer).toContain('isArabic ? "left-4 slide-in-from-left-4"');
    expect(composer).toContain('"right-4 slide-in-from-right-4"');
    expect(composer).toContain('"fixed bottom-4');
    expect(composer).not.toContain("current >= 92");
    expect(composer).not.toContain('tr("الوقت المنقضي")');
    expect(composer).toContain('uploading: tr("جاري رفع الملفات بأمان")');
    expect(composer).toContain('delivering: tr("جاري تسليم الرسالة إلى خادم البريد")');
    expect(composer).toContain('confirming: tr("جاري تأكيد التسليم من خادم البريد")');
    expect(composer).toContain('dir={isArabic ? "rtl" : "ltr"}');
    expect(composer).toContain('role="progressbar"');
    expect(composer).toContain("window.setTimeout(resolve, 360)");
    expect(composer).toContain('setSendProgress({ progress: 100, stage: "complete" })');
    expect(composer).toContain('stage: hasAttachmentsToTransfer ? "uploading" : "preparing"');
    expect(composer).toContain("deliveryProgressForElapsed(performance.now() - startedAt)");
    expect(composer).toContain("startDeliveryProgress();");
    expect(composer).toContain("stopDeliveryProgress();");
  });

  it("releases transient Bridge staging without delaying the SMTP response", () => {
    const release = workingDraftServer.slice(
      workingDraftServer.indexOf('const release = fetch(`${bridge.bridgeUrl}/api/staged-release`'),
      workingDraftServer.indexOf("export async function checkpointWorkingDraft"),
    );
    expect(release).toContain("trackCloudflareWork(release)");
    expect(release).not.toContain("await fetch");
  });
});
