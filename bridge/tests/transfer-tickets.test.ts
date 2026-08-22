import assert from "node:assert/strict";
import test from "node:test";
import { accountBinding, openTransferTicket, sealTransferTicket } from "../src/transfer-tickets.js";

const secret = "test-secret-that-is-long-enough";
const account = accountBinding({ email_address: "a@example.com", imap_host: "imap.example.com" });

function ticket(exp = 10_000) {
  return sealTransferTicket(secret, {
    purpose: "attachment-upload",
    account,
    exp,
    data: { size: 4 },
  });
}

test("transfer ticket accepts valid purpose and account", () => {
  const parsed = openTransferTicket(secret, ticket(), {
    purpose: "attachment-upload",
    account,
    now: 1,
  });
  assert.equal(parsed.data.size, 4);
});

test("transfer ticket rotation verifies current and bounded legacy keys", () => {
  const currentSecret = "current-ticket-secret";
  const legacySecret = "legacy-ticket-secret";
  const current = sealTransferTicket(currentSecret, {
    purpose: "attachment-upload",
    account,
    exp: 10_000,
    data: { generation: "current" },
  });
  const legacy = sealTransferTicket(legacySecret, {
    purpose: "attachment-upload",
    account,
    exp: 10_000,
    data: { generation: "legacy" },
  });
  const keys = [currentSecret, legacySecret] as const;

  assert.equal(
    openTransferTicket(keys, current, { purpose: "attachment-upload", account, now: 1 }).data.generation,
    "current",
  );
  assert.equal(
    openTransferTicket(keys, legacy, { purpose: "attachment-upload", account, now: 1 }).data.generation,
    "legacy",
  );
  assert.throws(
    () => openTransferTicket([currentSecret], legacy, { purpose: "attachment-upload", account, now: 1 }),
    /INVALID_TICKET/,
  );
  assert.throws(
    () => openTransferTicket(keys, legacy, { purpose: "attachment-download", account, now: 1 }),
    /WRONG_TICKET_PURPOSE/,
  );
});

test("transfer ticket rejects expiry, wrong purpose, tampering, and account mismatch", () => {
  assert.throws(
    () => openTransferTicket(secret, ticket(10), { purpose: "attachment-upload", now: 10 }),
    /EXPIRED_TICKET/,
  );
  assert.throws(
    () => openTransferTicket(secret, ticket(), { purpose: "attachment-download", now: 1 }),
    /WRONG_TICKET_PURPOSE/,
  );
  const valid = ticket();
  const segments = valid.split(".");
  const index = Math.floor(segments[1].length / 2);
  segments[1] = `${segments[1].slice(0, index)}${segments[1][index] === "a" ? "b" : "a"}${segments[1].slice(index + 1)}`;
  const tampered = segments.join(".");
  assert.throws(
    () => openTransferTicket(secret, tampered, { purpose: "attachment-upload", now: 1 }),
    /INVALID_TICKET/,
  );
  assert.throws(
    () =>
      openTransferTicket(secret, valid, {
        purpose: "attachment-upload",
        account: "f".repeat(64),
        now: 1,
      }),
    /TICKET_ACCOUNT_MISMATCH/,
  );
});
