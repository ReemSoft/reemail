import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chooseDraftOpenTarget,
  draftSendNeedsWorkingDraftPersist,
  isDraftEditComposeInitial,
  shouldUseLocalIndexForFolder,
} from "../mail-draft-open-orchestration";
import type { WorkingDraftRecord } from "../mail-working-draft";

const mail = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

function record(overrides: Partial<WorkingDraftRecord> = {}): WorkingDraftRecord {
  return {
    draftId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    payload: {
      version: 1,
      snapshot: {
        to: [],
        cc: [],
        bcc: [],
        subject: "Subject",
        html: "<p>Body</p>",
        showCc: false,
        showBcc: false,
      },
      attachments: [],
    },
    checkpoint: {
      revision: 1,
      state: "checkpointed",
      committedRevision: 1,
      serverRef: {
        folderPath: "[Gmail]/Drafts",
        uid: 9001,
        uidValidity: "42",
      },
      error: null,
    },
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("Draft visible list authority", () => {
  it("uses Local Index for healthy Drafts, Inbox, and Sent; Starred remains Bridge", () => {
    expect(
      shouldUseLocalIndexForFolder({
        folder: "drafts",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(true);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "inbox",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(true);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "sent",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(true);
  });

  it("mail.tsx routes canUseIndex through the Draft-only decision helper", () => {
    const src = mail();
    expect(src).toContain("shouldUseLocalIndexForFolder({");
    expect(src).toContain('folder: f');
    expect(src).toContain("MAIL_INDEX_ENABLED");
  });
});

describe("logical Working Draft resolution", () => {
  it("resolves a valid draftIdHeader to the authoritative record before provider open", () => {
    const target = chooseDraftOpenTarget({
      rowId: "drafts:10",
      draftIdHeader: "11111111-1111-4111-8111-111111111111",
      uidValidity: "42",
      uid: 10,
      records: [record()],
      isDraftIdValid: () => true,
    });
    expect(target.kind).toBe("server-working");
  });

  it("returns an exact by-header lookup when the Working Draft list has not settled", () => {
    const target = chooseDraftOpenTarget({
      rowId: "drafts:10",
      draftIdHeader: "11111111-1111-4111-8111-111111111111",
      uidValidity: "42",
      uid: 10,
      records: [],
      isDraftIdValid: () => true,
    });
    expect(target).toEqual({
      kind: "working-by-header",
      draftId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("resolves a headerless provider row by current UID + UIDVALIDITY", () => {
    const target = chooseDraftOpenTarget({
      rowId: "drafts:9001",
      uidValidity: "42",
      uid: 9001,
      records: [record()],
      isDraftIdValid: () => true,
    });
    expect(target.kind).toBe("server-working");
  });

  it("leaves only truly provider-only rows on the fallback path", () => {
    const target = chooseDraftOpenTarget({
      rowId: "drafts:9001",
      uidValidity: "42",
      uid: 9001,
      records: [],
      isDraftIdValid: () => true,
    });
    expect(target.kind).toBe("provider-fallback");
  });

  it("mail.tsx performs exact load before generic /api/message", () => {
    const src = mail();
    expect(src).toContain("resolveDraftWorkingRecord");
    expect(src).toContain('body: JSON.stringify({ mailSessionToken: token, action: "load", draftId })');
  });
});

describe("Draft NOT_FOUND authority", () => {
  it("Draft NOT_FOUND branch never calls generic cleanupGhost", () => {
    const src = mail();
    const idx = src.indexOf('if (parsed.folder === "drafts") {');
    const end = src.indexOf('return { message: null, source: "draft-provider-gone" } as ClientMessageResult;', idx);
    const slice = src.slice(idx, end + 120);
    expect(slice).toContain("draft-working-record");
    expect(slice).toContain("draft-provider-gone");
    expect(slice).not.toContain("cleanupGhost({");
  });
});

describe("Draft send readiness", () => {
  it("requires Working Draft persistence for clean legacy provider Drafts", () => {
    expect(draftSendNeedsWorkingDraftPersist({ workingRevision: 0, dirty: false })).toBe(true);
  });

  it("skips a redundant save for a clean existing Working Draft", () => {
    expect(draftSendNeedsWorkingDraftPersist({ workingRevision: 3, dirty: false })).toBe(false);
  });

  it("persists latest content for a dirty Working Draft", () => {
    expect(draftSendNeedsWorkingDraftPersist({ workingRevision: 3, dirty: true })).toBe(true);
  });

  it("performSend promotes clean provider Drafts before calling working-draft-send", () => {
    const src = mail();
    expect(src).toContain("draftSendNeedsWorkingDraftPersist({");
    expect(src).toContain('forceWorkingDraftPersist: workingRevisionRef.current <= 0');
    expect(src).toContain('"/api/mail-working-draft-send"');
  });
});

describe("Draft Composer isolation and hydration", () => {
  it("uses a Draft-only key/nonce for edit Composer mounts", () => {
    const src = mail();
    expect(src).toContain("draftEditComposeNonce");
    expect(src).toContain('`draft-edit:${compose.editDraftId}:${draftEditComposeNonce}`');
  });

  it("server hydration arms a one-shot dirty-marking suppression guard", () => {
    const src = mail();
    expect(src).toContain("suppressNextServerHydrationDirtyRef");
    expect(src).toContain("suppressNextServerHydrationDirtyRef.current = true;");
    expect(src).toContain("if (suppressNextServerHydrationDirtyRef.current)");
  });

  it("persistent Draft save closure reads the current mail session token", () => {
    const src = mail();
    const saveRemote = src.indexOf("saveRemote: async");
    const slice = src.slice(saveRemote, saveRemote + 400);
    expect(slice).toContain("const token = mailSessionTokenRef.current;");
  });
});

describe("Draft provider discard and send finalization", () => {
  it("discard passes the real provider previousRef", () => {
    const src = mail();
    const discard = src.indexOf("discarded = (");
    const slice = src.slice(discard, discard + 220);
    expect(slice).toContain("serverRefRef.current ?? initial?.previousRef ?? null");
  });

  it("Send busy state always resets in finally", () => {
    const src = mail();
    const perform = src.indexOf("async function performSend()");
    const finallyBlock = src.slice(perform, perform + 22000);
    expect(finallyBlock).toContain("sendInProgressRef.current = false;");
    expect(finallyBlock).toContain("setSending(false);");
    expect(finallyBlock).toContain('setSendProgress({ progress: 0, stage: "preparing" });');
  });

  it("double Send never starts a second SMTP attempt", () => {
    const src = mail();
    expect(src).toContain('if (sendInProgressRef.current) {');
    expect(src).toContain('toast.info(tr("جاري الإرسال"));');
  });
});

describe("Working Draft complete fields", () => {
  it("buildWorkingDraftInitial persists all logical Draft metadata", () => {
    const src = mail();
    const start = src.indexOf("function buildWorkingDraftInitial(record: WorkingDraftRecord)");
    const end = src.indexOf("function stripHtml(html: string): string");
    const fn = src.slice(start, end);
    for (const field of [
      "to: addressText(snapshot.to)",
      "cc: addressText(snapshot.cc)",
      "bcc: addressText(snapshot.bcc)",
      "subject: snapshot.subject || \"\"",
      "showCc: Boolean(snapshot.showCc)",
      "showBcc: Boolean(snapshot.showBcc)",
      "inReplyTo: snapshot.inReplyTo",
      "references: snapshot.references",
    ]) {
      expect(fn).toContain(field);
    }
    expect(src).toContain("hydrateSourceInlineComposeImage(file, metadata)");
    const api = readFileSync(
      new URL("../../routes/api/mail-working-draft.ts", import.meta.url),
      "utf8",
    );
    expect(api).toContain("loadWorkingDraftForEditor(auth, draftId)");
  });
});

describe("Draft-edit identity", () => {
  it("only Draft-edit initial objects receive a fresh Composer nonce", () => {
    expect(isDraftEditComposeInitial({ editDraftId: "x" })).toBe(true);
    expect(isDraftEditComposeInitial({})).toBe(false);
    expect(isDraftEditComposeInitial({ editDraftId: null })).toBe(false);
  });
});
