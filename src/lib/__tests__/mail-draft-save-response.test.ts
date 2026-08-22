import { describe, expect, it } from "vitest";
import { parseDraftSaveResponse } from "@/lib/mail-draft-save-response";

describe("parseDraftSaveResponse", () => {
  it("maps missing and failed responses to the existing coarse error semantics", () => {
    expect(parseDraftSaveResponse(null, false)).toEqual({ kind: "failure", code: "NETWORK" });
    expect(parseDraftSaveResponse(null, true)).toEqual({ kind: "failure", code: "UNKNOWN" });
    expect(parseDraftSaveResponse({ ok: false, code: "IMAP_BUSY" }, true)).toEqual({
      kind: "failure",
      code: "IMAP_BUSY",
    });
    expect(parseDraftSaveResponse({ ok: false, error: "FAILED" }, true)).toEqual({
      kind: "failure",
      code: "FAILED",
    });
  });

  it("returns a typed server ref only when all physical identity fields are valid", () => {
    expect(
      parseDraftSaveResponse(
        {
          ok: true,
          folderPath: "Drafts",
          uid: 42,
          uidValidity: "123",
        },
        true,
      ),
    ).toMatchObject({
      kind: "success",
      serverRef: { folderPath: "Drafts", uid: 42, uidValidity: "123" },
    });

    const missingUid = parseDraftSaveResponse(
      { ok: true, folderPath: "Drafts", uidValidity: "123" },
      true,
    );
    expect(missingUid.kind).toBe("success");
    if (missingUid.kind === "success") expect(missingUid.serverRef).toBeUndefined();
  });

  it("normalizes optional handle arrays without casts in the caller", () => {
    const parsed = parseDraftSaveResponse(
      {
        ok: true,
        sourceAttachmentHandles: ["a", "b"],
        inlineSourceHandles: "not-an-array",
      },
      true,
    );

    expect(parsed.kind).toBe("success");
    if (parsed.kind !== "success") return;
    expect(parsed.sourceAttachmentHandles).toEqual(["a", "b"]);
    expect(parsed.inlineSourceHandles).toBeNull();
  });

  it("treats reconciled as true only for the literal boolean true", () => {
    const yes = parseDraftSaveResponse({ ok: true, reconciled: true }, true);
    const no = parseDraftSaveResponse({ ok: true, reconciled: "true" }, true);

    expect(yes.kind).toBe("success");
    expect(no.kind).toBe("success");
    if (yes.kind === "success") expect(yes.reconciled).toBe(true);
    if (no.kind === "success") expect(no.reconciled).toBe(false);
  });
});
