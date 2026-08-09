import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const sendV2 = source.slice(
  source.indexOf('app.post("/api/send-v2"'),
  source.indexOf("// ---- Drafts"),
);
const draftV2 = source.slice(
  source.indexOf('app.post("/api/draft-save-v2"'),
  source.indexOf("// ---- Drafts"),
);

test("send-v2 releases client handles only after SMTP success", () => {
  assert.match(sendV2, /if \(!result\.ok\) return[\s\S]*sendSucceeded = true/);
  assert.match(sendV2, /cleanupSendStagedAttachments/);
  assert.match(sendV2, /clientHandles/);
  assert.match(sendV2, /sourceHandles/);
});

test("draft-save-v2 retains staged handles for reuse", () => {
  assert.doesNotMatch(draftV2, /cleanupSendStagedAttachments|releaseStagedAttachment/);
});
