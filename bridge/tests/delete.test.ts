// Bridge permanent-delete routing tests (Blocker 1).
//
// Contract exercised (no live IMAP):
//   * decideDeleteMode("trash")   → "permanent"  → messageDelete path
//   * decideDeleteMode(<other>)   → "trash"      → messageMove path
//
// The pure decider is the single source of truth the /api/delete endpoint
// uses to pick a code path; guarding it here means a regression cannot
// silently reintroduce `messageMove` on trash-permanent-delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDeleteMode } from "../src/imap.js";
import type { MailFolder } from "../src/types.js";

test("trash source routes to permanent delete", () => {
  assert.equal(decideDeleteMode("trash"), "permanent");
});

test("non-trash sources all route to move-to-trash", () => {
  const others: MailFolder[] = [
    "inbox",
    "starred",
    "sent",
    "drafts",
    "spam",
    "archive",
    "all",
  ];
  for (const f of others) {
    assert.equal(decideDeleteMode(f), "trash", `folder=${f}`);
  }
});
