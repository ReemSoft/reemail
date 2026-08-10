import assert from "node:assert/strict";
import test from "node:test";
import { classifyImapFailure } from "../src/imap-failure.js";

test("classifyImapFailure returns only coarse retryable transport categories", () => {
  assert.deepEqual(classifyImapFailure({ code: "ETIMEDOUT" }), {
    code: "IMAP_TIMEOUT",
    retryable: true,
  });
  assert.deepEqual(classifyImapFailure({ code: "ECONNRESET" }), {
    code: "IMAP_CONNECTION_RESET",
    retryable: true,
  });
  assert.deepEqual(classifyImapFailure({ code: "ECONNECTIONCLOSED" }), {
    code: "IMAP_CONNECTION_CLOSED",
    retryable: true,
  });
});

test("classifyImapFailure marks auth, quota, permission and protocol failures permanent", () => {
  assert.deepEqual(classifyImapFailure({ serverResponseCode: "AUTHENTICATIONFAILED" }), {
    code: "IMAP_AUTH_FAILED",
    retryable: false,
  });
  assert.deepEqual(classifyImapFailure({ serverResponseCode: "OVERQUOTA" }), {
    code: "IMAP_QUOTA_EXCEEDED",
    retryable: false,
  });
  assert.deepEqual(classifyImapFailure({ serverResponseCode: "NOPERM" }), {
    code: "IMAP_PERMISSION_DENIED",
    retryable: false,
  });
  assert.deepEqual(classifyImapFailure({ responseStatus: "BAD" }), {
    code: "IMAP_PROTOCOL_ERROR",
    retryable: false,
  });
});

test("classifyImapFailure fails unknown errors closed without exposing raw text", () => {
  assert.deepEqual(classifyImapFailure(new Error("private provider detail")), {
    code: "IMAP_UNKNOWN",
    retryable: false,
  });
});
