import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("active attachment V2 contract", () => {
  const composer = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

  it("stages selected files before send and sends handle-only JSON", () => {
    expect(composer).toContain('ensureStaged(file, "attachment")');
    expect(composer).toContain('fetch("/api/mail-send-v2"');
    expect(composer).toContain("...stagedNormal.map((item) => item.handle)");
    const sendBody = composer.slice(composer.indexOf("async function performSend"));
    expect(sendBody).not.toContain('xhr.open("POST", "/api/mail-send")');
    expect(sendBody).not.toContain("xhr.send(form)");
  });
});
