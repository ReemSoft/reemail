import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("normal attachment direct-download contract", () => {
  const composer = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
  const card = composer.slice(composer.indexOf("function AttachmentCard"));

  it("requests only a ticket and never buffers a Blob", () => {
    expect(card).toContain('fetch("/api/mail-attachment-ticket"');
    expect(card).not.toContain("res.blob()");
    expect(card).not.toContain("URL.createObjectURL");
    expect(card).toContain('requestTransferUrl("download")');
    expect(card).toContain('requestTransferUrl("preview")');
  });
});
