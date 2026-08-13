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
const conversationRuntime = migration.slice(
  migration.indexOf("CREATE OR REPLACE FUNCTION public.get_mail_conversation"),
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
  it("normalizes historical scalar and reference values once in a changed-row backfill", () => {
    expect(migration).toContain("public.normalize_mail_rfc_message_id");
    expect(migration).toContain("UPDATE public.mail_messages");
    expect(migration).toContain("IS DISTINCT FROM");
    expect(migration).toContain("WITH ORDINALITY");
    expect(migration).not.toMatch(/SET\s+(?:body|subject|from_addr|internal_date|size_bytes)/i);
  });

  it("classifies only an encountered exact Message-ID with the approved signature", () => {
    expect(migration).toContain("mail_rfc_message_id_is_unambiguous");
    expect(migration).toContain("m.message_id = _message_id");
    expect(migration).toContain("internal_date");
    expect(migration).toContain("lower(btrim(_from_addr->>'email'))");
    expect(migration).toContain("subject");
    expect(migration).toContain("size_bytes");
  });

  it("rejects the failed account-wide runtime architecture", () => {
    expect(migration).not.toMatch(/scoped_rows\s+AS\s+MATERIALIZED/i);
    expect(migration).not.toMatch(/identity_stats\s+AS\s+MATERIALIZED/i);
    expect(conversationRuntime).not.toMatch(
      /normalize_mail_rfc_message_id\(m\.(?:message_id|in_reply_to)\)/,
    );
  });

  it("drops an ambiguous anchor ID while retaining independently safe ancestry seeds", () => {
    expect(conversationRuntime).toContain(
      "ARRAY[a.message_id, a.in_reply_to] || COALESCE(a.references_ids",
    );
    expect(conversationRuntime).toMatch(
      /AS linked\(id\)[\s\S]+WHERE public\.mail_rfc_message_id_is_unambiguous\([\s\S]+linked\.id/,
    );
  });

  it("uses three targeted indexable ancestry branches", () => {
    expect(migration).toContain("m.message_id = current_id.id");
    expect(migration).toContain("m.in_reply_to = current_id.id");
    expect(migration).toContain("m.references_ids @> ARRAY[current_id.id]");
    expect(migration.match(/UNION/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps traversal scoped, cycle-safe and result bounded", () => {
    expect(migration).toContain("m.company_id = _company_id");
    expect(migration).toContain("m.account_id = _account_id");
    expect(migration).toContain("UNION\n");
    expect(migration).toContain("mail_rfc_message_id_is_unambiguous(");
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

  it("keeps a safe parent usable when the selected anchor ID is ambiguous", () => {
    const rows = [
      fixture("anchor"),
      fixture("collision", { sender: "other@example.com" }),
      fixture("parent", { messageId: "<parent@example.com>" }),
    ];
    const safe = safeIds(rows, "c1", "a1");
    expect(safe).not.toContain("<same@example.com>");
    expect(safe).toContain("<parent@example.com>");
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
