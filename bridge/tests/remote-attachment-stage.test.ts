import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isAllowedRemoteAttachmentUrl } from "../src/remote-attachment-stage.js";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("remote attachment staging accepts Supabase signed storage URLs", () => {
  assert.equal(
    isAllowedRemoteAttachmentUrl(
      "https://project.supabase.co/storage/v1/object/sign/mail-draft-attachments/file?token=signed",
      {},
    ),
    true,
  );
});

test("remote attachment staging rejects SSRF targets and redirects by origin", () => {
  assert.equal(isAllowedRemoteAttachmentUrl("http://127.0.0.1/private", {}), false);
  assert.equal(isAllowedRemoteAttachmentUrl("https://project.supabase.co.evil.test/file", {}), false);
  assert.equal(isAllowedRemoteAttachmentUrl("https://user:pass@project.supabase.co/file", {}), false);
});

test("remote attachment staging supports an explicit custom storage host", () => {
  assert.equal(
    isAllowedRemoteAttachmentUrl("https://storage.example.com/object/signed", {
      MAIL_REMOTE_ATTACHMENT_HOSTS: "storage.example.com",
    }),
    true,
  );
});

test("remote staging is authenticated, bounded, redirect-safe, and streamed to disk", () => {
  const start = indexSource.indexOf('app.post("/api/remote-attachment-stage"');
  const end = indexSource.indexOf('app.post("/api/send-v2"', start);
  const route = indexSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /requireKey/);
  assert.match(route, /directUploadGate\.tryAcquire\(\)/);
  assert.match(route, /redirect: "error"/);
  assert.match(route, /AbortSignal\.timeout\(120_000\)/);
  assert.match(route, /stageAttachmentStream\(/);
  assert.match(route, /Readable\.fromWeb\(upstream\.body/);
  assert.match(route, /finally\s*{\s*release\(\)/);
});
