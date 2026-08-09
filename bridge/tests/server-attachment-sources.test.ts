import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("existing draft attachments stay on the Bridge data plane", () => {
  const source = readFileSync(
    new URL("../src/server-attachment-sources.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /withAccountMailbox/);
  assert.match(source, /stageAttachmentStream/);
  assert.match(source, /SOURCE_UIDVALIDITY_MISMATCH/);
  assert.doesNotMatch(source, /Buffer\.concat|\.build\(/);
});
