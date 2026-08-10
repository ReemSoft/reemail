import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("send status is API-key protected, bounded, and memory-only", () => {
  const route = source.match(/app\.post\("\/api\/send-status", requireKey,[\s\S]*?\n\}\);/)?.[0];
  assert.ok(route);
  assert.match(route, /postSendFinalizers\.getStatus/);
  assert.match(route, /sentCopyAccountKey/);
  assert.match(route, /STATUS_NOT_FOUND/);
  assert.doesNotMatch(route, /password|withAccountMailbox|makeImapClient|imapGate/);
});

test("send status schema accepts only account identity and an opaque bounded id", () => {
  const schema = source.match(/const SendStatusPayloadSchema = z\.object\([\s\S]*?\n\}\);/)?.[0];
  assert.ok(schema);
  assert.match(schema, /account: AccountSchema/);
  assert.match(schema, /jobId: z\.string\(\)\.min\(32\)\.max\(128\)/);
  assert.doesNotMatch(schema, /password|recipient|subject|body|attachment/);
});
