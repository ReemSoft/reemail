import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftTriggerDiagnosticsSchema } from "../src/drafts.js";

test("Draft trigger diagnostics accept the allowed PII-safe shape", () => {
  const parsed = DraftTriggerDiagnosticsSchema.parse({
    reason: "automatic",
    generation: 12,
    inFlight: true,
    coalesced: true,
    dirty: true,
    attachmentsChanged: false,
  });
  assert.deepEqual(parsed, {
    reason: "automatic",
    generation: 12,
    inFlight: true,
    coalesced: true,
    dirty: true,
    attachmentsChanged: false,
  });
});

test("Draft trigger diagnostics reject identity/content fields", () => {
  assert.throws(
    () =>
      DraftTriggerDiagnosticsSchema.parse({
        reason: "explicit",
        generation: 3,
        inFlight: false,
        coalesced: false,
        dirty: false,
        attachmentsChanged: true,
        draftId: "should-not-survive",
        uid: 999,
        subject: "should-not-survive",
      }),
    /draftId|uid|subject/,
  );
});

test("Draft trigger diagnostics reject an unknown reason", () => {
  assert.throws(
    () =>
      DraftTriggerDiagnosticsSchema.parse({
        reason: "not-allowed",
        generation: 0,
        inFlight: false,
        coalesced: false,
        dirty: false,
        attachmentsChanged: false,
      }),
    /reason/,
  );
});
