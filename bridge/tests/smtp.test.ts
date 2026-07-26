// Regression tests for the Sent-copy resolution path in the Bridge SMTP
// module. Guards against silently dropping SPECIAL-USE detection or the
// well-known Sent-folder fallback list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSentPath } from "../src/smtp.js";

// The imapflow ListResponse we care about is loosely shaped: { path,
// specialUse? }. Cast through unknown so we don't have to import the full
// type surface for a shape assertion.
function box(path: string, specialUse?: string): any {
  return specialUse ? { path, specialUse } : { path };
}

test("resolveSentPath prefers SPECIAL-USE \\Sent over any well-known name", () => {
  const boxes = [
    box("INBOX"),
    box("Custom/OutgoingCopies", "\\Sent"),
    box("Sent"),
    box("[Gmail]/Sent"),
  ];
  assert.equal(resolveSentPath(boxes as any), "Custom/OutgoingCopies");
});

test("resolveSentPath falls back to well-known 'Sent' when SPECIAL-USE is absent", () => {
  const boxes = [box("INBOX"), box("Drafts"), box("Sent"), box("Trash")];
  assert.equal(resolveSentPath(boxes as any), "Sent");
});

test("resolveSentPath recognizes [Gmail]/Sent Mail", () => {
  const boxes = [box("INBOX"), box("[Gmail]/Sent Mail"), box("[Gmail]/Trash")];
  assert.equal(resolveSentPath(boxes as any), "[Gmail]/Sent Mail");
});

test("resolveSentPath recognizes localized Arabic 'المرسلة'", () => {
  const boxes = [box("INBOX"), box("المرسلة"), box("المهملات")];
  assert.equal(resolveSentPath(boxes as any), "المرسلة");
});

test("resolveSentPath is case-insensitive on well-known names", () => {
  const boxes = [box("INBOX"), box("sent")];
  assert.equal(resolveSentPath(boxes as any), "sent");
});

test("resolveSentPath returns undefined when no Sent-like folder exists (APPEND is skipped)", () => {
  const boxes = [box("INBOX"), box("Trash"), box("Drafts")];
  assert.equal(resolveSentPath(boxes as any), undefined);
});
