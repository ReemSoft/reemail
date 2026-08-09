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

test("active send-v2 acknowledges SMTP before bounded Sent finalization", () => {
  assert.match(sendV2, /sendMessageFast/);
  assert.match(sendV2, /Server-Timing/);
  assert.doesNotMatch(sendV2, /await sendMessage\(/);
});

test("direct upload exposes coarse stage timing without changing its raw stream path", () => {
  const upload = source.slice(
    source.indexOf('app.post("/api/direct/attachment-upload"'),
    source.indexOf('app.post("/api/send-v2"'),
  );
  assert.match(upload, /stageAttachmentStream/);
  assert.match(upload, /X-MailMaestro-Stage-Ms/);
  assert.match(upload, /Server-Timing/);
  assert.doesNotMatch(upload, /Buffer\.concat|express\.json/);
});
