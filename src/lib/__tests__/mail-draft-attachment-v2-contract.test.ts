import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readDraftDoc, writeDraftDoc, type DraftDocV3 } from "../mail-draft-lifecycle";

describe("draft attachment V2 contract", () => {
  const composer = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

  it("reuses one staged upload and sends no attachment bytes on autosave", () => {
    expect(composer).toContain("stagedUploadsRef.current.get(file)");
    expect(composer).toContain('fetch("/api/mail-draft-save-v2"');
    expect(composer).toContain("sourceAttachments");
    expect(composer).toContain("}, 5_000)");
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
});
