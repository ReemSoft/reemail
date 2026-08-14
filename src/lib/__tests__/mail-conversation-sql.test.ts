import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@/lib/mail-conversation.functions";
import { prepareConversationHistory } from "@/lib/mail-conversation-history";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260814074333_d97433dc-38bc-4691-a4dc-2d8e392fab08.sql",
    import.meta.url,
  ),
  "utf8",
);

type SqlRow = Pick<ConversationRow, "folder" | "uid" | "uidValidity" | "date">;
const folderOrder: Record<ConversationRow["folder"], number> = {
  inbox: 0,
  starred: 1,
  sent: 2,
  drafts: 3,
  spam: 4,
  trash: 5,
  archive: 6,
  all: 7,
};

function compare(left: SqlRow, right: SqlRow): number {
  const date =
    Date.parse(left.date || "1970-01-01T00:00:00.000Z") -
    Date.parse(right.date || "1970-01-01T00:00:00.000Z");
  if (date) return date;
  const folder = folderOrder[left.folder] - folderOrder[right.folder];
  if (folder) return folder;
  if (left.uid !== right.uid) return left.uid - right.uid;
  const leftValidity = BigInt(left.uidValidity);
  const rightValidity = BigInt(right.uidValidity);
  return leftValidity < rightValidity ? -1 : leftValidity > rightValidity ? 1 : 0;
}

function sqlWindow(rows: SqlRow[], selected: SqlRow, limit = 25): SqlRow[] {
  return rows
    .filter((item) => compare(item, selected) < 0)
    .sort((left, right) => compare(right, left))
    .slice(0, limit);
}

function row(uid: number, date = new Date(uid * 1_000).toISOString()): SqlRow {
  return { folder: "inbox", uid, uidValidity: "9", date };
}

describe("get_mail_conversation nearest-previous SQL window", () => {
  it("replaces only the existing RPC while preserving its contract and permissions", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_mail_conversation(");
    expect(migration).toContain("_limit integer DEFAULT 50");
    expect(migration).toContain("RETURNS TABLE(");
    expect(migration).toContain("LANGUAGE sql\nSTABLE\nSECURITY INVOKER\nSET search_path = public");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.get_mail_conversation");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.get_mail_conversation");
    expect(migration).not.toMatch(/ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP TABLE|DELETE FROM/);
    expect(migration.match(/UPDATE public\./g)).toHaveLength(1);
    expect(migration).toContain(
      "UPDATE public.mail_messages m\nSET\n  message_id = n.message_id,\n  in_reply_to = n.in_reply_to,\n  references_ids = n.references_ids\nFROM normalized_values n\nWHERE m.id = n.id\n  AND (m.message_id, m.in_reply_to, m.references_ids)\n      IS DISTINCT FROM\n      (n.message_id, n.in_reply_to, n.references_ids);",
    );
  });

  it("anchors once, filters before ordering, and preserves one bounded result", () => {
    expect(migration.match(/anchor AS \(/g)).toHaveLength(1);
    expect(migration).toContain("CASE WHEN m.uidvalidity = f.uidvalidity THEN 0 ELSE 1 END");
    expect(migration).toContain("CROSS JOIN anchor_identity a");
    expect(migration).toContain("WHERE c.copy_rank = 1");
    expect(migration).toContain("c.logical_copy_key <> a.logical_copy_key");
    expect(migration).toContain(
      "WHEN safe_message_id.id IS NOT NULL\n          AND signatures.copy_signature IS NOT NULL\n        THEN m.message_id || E'\\x1f' || signatures.copy_signature\n        ELSE m.id::text\n      END AS logical_copy_key",
    );
    expect(migration).toContain(
      "WHEN safe_message_id.id IS NOT NULL\n          AND signatures.copy_signature IS NOT NULL\n        THEN a.message_id || E'\\x1f' || signatures.copy_signature\n        ELSE a.id::text\n      END AS logical_copy_key",
    );
    expect(migration).toContain("COALESCE(c.internal_date, 'epoch'::timestamptz)");
    expect(migration).toContain("LIMIT LEAST(GREATEST(_limit, 1), 25)");
    expect(migration).not.toMatch(/body_html|body_text|attachment_bytes|cid_bytes/i);
  });

  for (const size of [1, 2, 24, 25, 26, 30, 50, 100]) {
    it(`returns nearest previous rows for ${size} metadata messages`, () => {
      const rows = Array.from({ length: size }, (_, index) => row(index + 1));
      const latest = sqlWindow(rows, row(size));
      expect(latest.map((item) => item.uid)).toEqual(
        rows
          .slice(Math.max(0, size - 26), size - 1)
          .reverse()
          .map((item) => item.uid),
      );
      const middle = Math.max(1, Math.ceil(size / 2));
      expect(sqlWindow(rows, row(middle)).every((item) => item.uid < middle)).toBe(true);
      expect(sqlWindow(rows, row(1))).toEqual([]);
    });
  }

  it("permanently reproduces the old 30-message truncation failure", () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(index + 1));
    const oldAscendingLimit = rows.slice(0, 25).map((item) => item.uid);
    expect(oldAscendingLimit).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(sqlWindow(rows, row(30)).map((item) => item.uid)).toEqual(
      Array.from({ length: 25 }, (_, index) => 29 - index),
    );
  });

  it("returns 5..29 for message 30 of 50 and 75..99 for message 100", () => {
    const fifty = Array.from({ length: 50 }, (_, index) => row(index + 1));
    expect(sqlWindow(fifty, row(30)).map((item) => item.uid)).toEqual(
      Array.from({ length: 25 }, (_, index) => 29 - index),
    );
    const hundred = Array.from({ length: 100 }, (_, index) => row(index + 1));
    expect(sqlWindow(hundred, row(100)).map((item) => item.uid)).toEqual(
      Array.from({ length: 25 }, (_, index) => 99 - index),
    );
  });

  it("agrees exactly with the frontend for equal timestamps and numeric UIDVALIDITY", () => {
    const date = "2026-08-12T10:00:00.000Z";
    const rows: ConversationRow[] = [
      { ...row(3, date), uidValidity: "10" },
      { ...row(3, date), uidValidity: "9" },
      { ...row(2, date), uidValidity: "100" },
    ].map((item) => ({
      ...item,
      subject: "",
      from: { name: "", email: "" },
      to: [],
      seen: false,
      flagged: false,
      hasAttachments: false,
      messageId: null,
    }));
    const anchor = { ...row(4, date), uidValidity: "1" };
    const sql = sqlWindow(rows, anchor).map((item) => `${item.uid}:${item.uidValidity}`);
    const frontend = prepareConversationHistory(rows, {
      id: "inbox:4",
      uidValidity: "1",
      date,
    }).map((item) => `${item.uid}:${item.uidValidity}`);
    expect(sql).toEqual(["3:10", "3:9", "2:100"]);
    expect(frontend).toEqual(sql);
  });

  it("maps a nullable database date to the same epoch fallback used by the client", () => {
    const nullDated = row(1, "");
    const later = row(2, "2026-08-12T10:00:00.000Z");
    expect(sqlWindow([later, nullDated], later).map((item) => item.uid)).toEqual([1]);
    expect(migration.match(/COALESCE\([^\n]+internal_date, 'epoch'::timestamptz\)/g)).toHaveLength(
      3,
    );
  });
});
