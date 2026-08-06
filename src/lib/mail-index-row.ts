// Pure, client-safe mappers between mail_messages rows and the UI MailMessage
// contract. Kept dependency-free so it can be unit-tested in isolation and
// imported from both server functions and (indirectly) UI code.
import type { MailAddress, MailFolder, MailMessage } from "@/lib/mail-types";

export interface IndexRow {
  uid: number;
  subject: string | null;
  from_addr: unknown;
  to_addrs: unknown;
  cc_addrs: unknown;
  internal_date: string | null;
  seen: boolean;
  flagged: boolean;
  has_attachments: boolean;
  message_id: string | null;
}

function coerceAddress(v: unknown): MailAddress {
  if (v && typeof v === "object") {
    const o = v as { name?: unknown; email?: unknown };
    const email = typeof o.email === "string" ? o.email : "";
    const name = typeof o.name === "string" && o.name.length ? o.name : email;
    return { name, email };
  }
  return { name: "", email: "" };
}

function coerceAddressList(v: unknown): MailAddress[] {
  if (!Array.isArray(v)) return [];
  return v.map(coerceAddress).filter((a) => a.email.length > 0 || a.name.length > 0);
}

/**
 * Map a stored index row to the UI's MailMessage contract. The index does not
 * persist body/preview — the client fetches those on-open via the existing
 * per-message bridge fetcher, so `body` and `preview` are left empty.
 */
export function indexRowToMailMessage(folder: MailFolder, row: IndexRow): MailMessage {
  const to = coerceAddressList(row.to_addrs);
  const cc = coerceAddressList(row.cc_addrs);
  return {
    id: `${folder}:${row.uid}`,
    threadId: row.message_id ?? `${folder}:${row.uid}`,
    folder,
    from: coerceAddress(row.from_addr),
    to,
    cc: cc.length ? cc : undefined,
    subject: row.subject ?? "",
    preview: "",
    body: "",
    date: row.internal_date ?? new Date(0).toISOString(),
    read: !!row.seen,
    starred: !!row.flagged,
    hasAttachments: !!row.has_attachments,
  };
}

export interface IndexCursor {
  /** ISO internal_date of last row in previous page. */
  date: string;
  /** DB row id of last row in previous page (tiebreaker). */
  id: string;
}

/**
 * Encode/decode the compound cursor as an opaque base64 string so callers
 * don't need to know the internal shape.
 */
export function encodeIndexCursor(c: IndexCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeIndexCursor(s: string): IndexCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as IndexCursor).date === "string" &&
      typeof (parsed as IndexCursor).id === "string"
    ) {
      return parsed as IndexCursor;
    }
    return null;
  } catch {
    return null;
  }
}
