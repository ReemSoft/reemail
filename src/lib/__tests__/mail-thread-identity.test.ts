import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_PERSISTED_THREAD_REFERENCES,
  normalizePersistedThreadIdentity,
} from "@/lib/mail-rfc-message-id";
import { mapSyncMessageToRow, type SyncMessagePayload } from "@/lib/mail-sync-writer.server";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260813090000_harden_conversation_identity.sql",
    import.meta.url,
  ),
  "utf8",
);

const base: SyncMessagePayload = {
  uid: 42,
  modseq: null,
  messageId: " m1@example.com ",
  inReplyTo: "parent@example.com",
  references: ["<root@example.com>", "root@example.com", "folder:55", "<parent@example.com>"],
  subject: "Subject",
  from: { name: "Sender", email: "sender@example.com" },
  to: [],
  cc: [],
  internalDate: "2026-08-13T00:00:00.000Z",
  sizeBytes: 100,
  hasAttachments: false,
  flagSeen: false,
  flagFlagged: false,
  flagAnswered: false,
  flagDraft: false,
  keywords: [],
};

type IdentityFixture = {
  id: string;
  company: string;
  account: string;
  messageId: string | null;
  date: string | null;
  sender: string | null;
  subject: string | null;
  size: number | null;
};

function signature(row: IdentityFixture): string | null {
  const id = normalizePersistedThreadIdentity(row.messageId);
  if (!id || !row.date || !row.sender?.trim() || row.subject === null || row.size === null) {
    return null;
  }
  return JSON.stringify([row.date, row.sender.trim().toLowerCase(), row.subject, row.size]);
}

function safeIds(rows: IdentityFixture[], company: string, account: string): Set<string> {
  const groups = new Map<string, IdentityFixture[]>();
  for (const row of rows) {
    if (row.company !== company || row.account !== account) continue;
    const id = normalizePersistedThreadIdentity(row.messageId);
    if (!id) continue;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  const safe = new Set<string>();
  for (const [id, group] of groups) {
    const values = group.map(signature);
    if (group.length === 1 || (values.every(Boolean) && new Set(values).size === 1)) safe.add(id);
  }
  return safe;
}

function logicalCopies(rows: IdentityFixture[], company = "c1", account = "a1"): string[] {
  const safe = safeIds(rows, company, account);
  return rows
    .filter((row) => row.company === company && row.account === account)
    .map((row) => {
      const id = normalizePersistedThreadIdentity(row.messageId);
      const copy = signature(row);
      return id && copy && safe.has(id) ? `${id}\u001f${copy}` : row.id;
    })
    .filter((key, index, all) => all.indexOf(key) === index);
}

function fixture(id: string, overrides: Partial<IdentityFixture> = {}): IdentityFixture {
  return {
    id,
    company: "c1",
    account: "a1",
    messageId: "<same@example.com>",
    date: "2026-08-13T00:00:00.000Z",
    sender: "sender@example.com",
    subject: "Subject",
    size: 100,
    ...overrides,
  };
}

describe("persistent RFC Message-ID normalization", () => {
  it.each([
    ["m1@example.com", "<m1@example.com>"],
    ["<m1@example.com>", "<m1@example.com>"],
    [" <Case.Sensitive@Example.COM> ", "<Case.Sensitive@Example.COM>"],
  ])("normalizes %s without lowercasing", (input, expected) => {
    expect(normalizePersistedThreadIdentity(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "folder:55",
    "550e8400-e29b-41d4-a716-446655440000",
    "<broken@example.com",
    "broken@example.com>",
    "<a@example.com> <b@example.com>",
    "<a@example.com>\r\nBcc: victim@example.com",
    "arbitrary",
  ])("rejects malformed ancestry identity %j", (input) => {
    expect(normalizePersistedThreadIdentity(input)).toBeNull();
  });

  it("normalizes future ingestion and bounds ordered unique references", () => {
    const row = mapSyncMessageToRow(
      { accountId: "a", companyId: "c", folderId: "f", uidValidity: "9" },
      {
        ...base,
        references: [
          ...Array.from({ length: 120 }, (_, index) => `<r${index}@example.com>`),
          "r0@example.com",
          "folder:55",
        ],
      },
    );
    expect(row.message_id).toBe("<m1@example.com>");
    expect(row.in_reply_to).toBe("<parent@example.com>");
    expect(row.references_ids).toHaveLength(MAX_PERSISTED_THREAD_REFERENCES);
    expect(row.references_ids[0]).toBe("<r0@example.com>");
    expect(row.references_ids).not.toContain("folder:55");
  });
});

describe("collision-safe conversation SQL", () => {
  it("normalizes historical scalar and reference values inside the RPC", () => {
    expect(migration).toContain("public.normalize_mail_rfc_message_id");
    expect(migration).toContain("normalized_references");
    expect(migration).toContain("WITH ORDINALITY");
  });

  it("dedupes only one complete logical copy signature", () => {
    expect(migration).toContain("copy_signature");
    expect(migration).toContain("internal_date");
    expect(migration).toContain("lower(btrim(m.from_addr->>'email'))");
    expect(migration).toContain("subject");
    expect(migration).toContain("size_bytes");
    expect(migration).toContain("count(DISTINCT copy_signature) AS signature_count");
    expect(migration).toContain("signatures_complete AND signature_count = 1");
  });

  it("fails reused or ambiguous IDs closed for ancestry expansion", () => {
    expect(migration).toContain("safe_message_ids");
    expect(migration).toMatch(/JOIN safe_message_ids[\s\S]+connected_ids/);
    expect(migration).not.toMatch(/PARTITION BY COALESCE\(m\.message_id/);
  });

  it("keeps traversal scoped, cycle-safe and result bounded", () => {
    expect(migration).toContain("m.company_id = _company_id");
    expect(migration).toContain("m.account_id = _account_id");
    expect(migration).toContain("UNION\n");
    expect(migration).toContain("LIMIT LEAST(GREATEST(_limit, 1), 25)");
  });

  it("preserves the one-RPC contract and hardened permissions", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_mail_conversation(");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("SET search_path = public");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.get_mail_conversation");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.get_mail_conversation");
    expect(migration).not.toMatch(/body_html|body_text|attachment_bytes|cid_bytes/i);
  });
});

describe("collision fixtures", () => {
  it("dedupes Inbox and Archive copies only when their stable signature matches", () => {
    expect(logicalCopies([fixture("inbox"), fixture("archive")])).toHaveLength(1);
  });

  it.each([
    ["different date", { date: "2026-08-13T00:01:00.000Z" }],
    ["different sender", { sender: "other@example.com" }],
    ["different subject", { subject: "Other" }],
    ["different size", { size: 101 }],
  ])("does not collapse a reused ID with %s", (_label, change) => {
    expect(logicalCopies([fixture("one"), fixture("two", change)])).toHaveLength(2);
  });

  it("marks reused or incomplete duplicate IDs unsafe for graph bridging", () => {
    const collision = [fixture("one"), fixture("two", { sender: "other@example.com" })];
    expect(safeIds(collision, "c1", "a1")).not.toContain("<same@example.com>");
    const incomplete = [fixture("three"), fixture("four", { size: null })];
    expect(safeIds(incomplete, "c1", "a1")).not.toContain("<same@example.com>");
  });

  it("keeps malformed, UUID and missing IDs physically distinct", () => {
    for (const messageId of ["folder:55", "550e8400-e29b-41d4-a716-446655440000", null]) {
      expect(logicalCopies([fixture("one", { messageId }), fixture("two", { messageId })])).toEqual(
        ["one", "two"],
      );
    }
  });

  it("normalizes bracketed and unbracketed equivalents into one copy group", () => {
    expect(
      logicalCopies([
        fixture("one", { messageId: "same@example.com" }),
        fixture("two", { messageId: "<same@example.com>" }),
      ]),
    ).toHaveLength(1);
  });

  it("isolates equal Message-IDs across accounts and companies", () => {
    const rows = [
      fixture("c1a1"),
      fixture("c1a2", { account: "a2" }),
      fixture("c2a1", { company: "c2" }),
    ];
    expect(logicalCopies(rows, "c1", "a1")).toEqual([
      '<same@example.com>\u001f["2026-08-13T00:00:00.000Z","sender@example.com","Subject",100]',
    ]);
    expect(logicalCopies(rows, "c1", "a2")).toHaveLength(1);
    expect(logicalCopies(rows, "c2", "a1")).toHaveLength(1);
  });
});
