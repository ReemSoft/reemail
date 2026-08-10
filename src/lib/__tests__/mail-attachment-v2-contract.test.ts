import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("active attachment V2 contract", () => {
  const composer = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

  it("stages selected files before send and sends handle-only JSON", () => {
    expect(composer).toContain('ensureStaged(file, "attachment")');
    expect(composer).toContain('fetch("/api/mail-send-v2"');
    expect(composer).toContain("buildStagedAttachmentTransport({");
    expect(composer).toContain("...attachmentTransport");
    const sendBody = composer.slice(composer.indexOf("async function performSend"));
    expect(sendBody).not.toContain('xhr.open("POST", "/api/mail-send")');
    expect(sendBody).not.toContain("xhr.send(form)");
  });

  it("preempts autosave and never awaits post-send draft deletion", () => {
    const sendBody = composer.slice(
      composer.indexOf("async function performSend"),
      composer.indexOf("async function handleSend"),
    );
    expect(sendBody).toContain("sendInProgressRef.current = true");
    expect(sendBody).toContain("autosaveRef.current?.cancel()");
    expect(sendBody).toContain("pendingRemoteSaveRef.current = null");
    expect(sendBody).toContain("deleteDraftAfterSend({");
    expect(sendBody.indexOf("deleteDraftAfterSend({")).toBeLessThan(
      sendBody.indexOf("onClose({ refreshDrafts: false })"),
    );
  });

  it("keeps attachment bytes off the App server", () => {
    const staging = readFileSync(new URL("../mail-attachment-staging.ts", import.meta.url), "utf8");
    expect(staging).toContain("xhr.send(file)");
    expect(staging).not.toContain("FormData");
    expect(composer).not.toContain("attachmentBase64");
  });

  it("forwards safe send timing while keeping upload bytes direct-to-Bridge", () => {
    const sendApi = readFileSync(
      new URL("../../routes/api/mail-send-v2.ts", import.meta.url),
      "utf8",
    );
    expect(sendApi).toContain('upstream.headers.get("Server-Timing")');
    expect(sendApi).not.toContain("attachmentBytes");
  });
});
