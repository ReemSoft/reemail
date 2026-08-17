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

test("draft-save-v2 releases fresh source staging only on failure, retains on success", () => {
  // The failure path must release the fresh server-source attachments staged
  // for this save (the client never learned their handles), while a successful
  // save returns them for reuse by the next save/send.
  assert.match(draftV2, /saveSucceeded = true/);
  assert.match(draftV2, /sourceAttachmentHandles: preserved\.map/);
  assert.match(draftV2, /inlineSourceHandles: preservedInlineSources\.map/);
  assert.match(
    draftV2,
    /if \(stagedAccount && abandonedSourceHandles\.length > 0 && !saveSucceeded\)/,
  );
  assert.match(
    draftV2,
    /releaseStagedAttachments\(BRIDGE_API_KEY, abandonedSourceHandles, stagedAccount\)/,
  );
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

test("aggregate decoded-size limit remains enforced after staging", () => {
  // The per-attachment decoded limiter covers a single file; the aggregate
  // check across every resolved attachment (client + source + inline) must
  // stay intact for send-v2 and draft-save-v2.
  assert.match(
    sendV2,
    /all\.reduce\(\(sum, item\) => sum \+ item\.size, 0\) > SEND_MAX_TOTAL_BYTES/,
  );
  assert.match(sendV2, /"ATTACHMENTS_TOO_LARGE"/);
  assert.match(
    draftV2,
    /all\.reduce\(\(sum, item\) => sum \+ item\.size, 0\) > SEND_MAX_TOTAL_BYTES/,
  );
  assert.match(draftV2, /"ATTACHMENTS_TOO_LARGE"/);
});
