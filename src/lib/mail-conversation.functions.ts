// Conversation listing from the LOCAL MAIL INDEX only (Postgres).
// Zero IMAP work, zero body fetches: it returns lightweight header rows for
// the sibling messages of a thread so the UI can render each previous message
// as its own entity (and lazily open its body + attachments on demand).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailAddress, MailFolder } from "@/lib/mail-types";

const FolderSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

const ListSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  folder: FolderSchema,
  uid: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).optional().default(25),
});

export interface ConversationRow {
  uid: number;
  folder: MailFolder;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  date: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  messageId: string | null;
}

export type ListConversationResult =
  | { ok: true; rows: ConversationRow[] }
  | { ok: false; error: string; rows: [] };

function coerceAddress(value: unknown): MailAddress {
  if (value && typeof value === "object") {
    const o = value as { name?: unknown; email?: unknown };
    const email = typeof o.email === "string" ? o.email : "";
    const name = typeof o.name === "string" && o.name.length ? o.name : email;
    return { name, email };
  }
  return { name: "", email: "" };
}

function coerceAddressList(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return [];
  return value.map(coerceAddress).filter((a) => a.email.length > 0 || a.name.length > 0);
}

export const listMailConversation = createServerFn({ method: "POST" })
  .inputValidator((value: z.input<typeof ListSchema>) => ListSchema.parse(value))
  .handler(async ({ data }): Promise<ListConversationResult> => {
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok) return { ok: false, error: auth.error, rows: [] };

    const { data: rows, error } = await supabaseAdmin.rpc("get_mail_conversation", {
      _company_id: auth.companyId,
      _account_id: auth.accountId,
      _canonical: data.folder,
      _uid: data.uid,
      _limit: data.limit,
    });
    if (error) return { ok: false, error: error.message, rows: [] };

    const mapped: ConversationRow[] = (rows ?? [])
      .filter((row) => !(row.canonical === data.folder && Number(row.uid) === data.uid))
      .map((row) => ({
        uid: Number(row.uid),
        folder: row.canonical as MailFolder,
        subject: row.subject ?? "",
        from: coerceAddress(row.from_addr),
        to: coerceAddressList(row.to_addrs),
        cc: coerceAddressList(row.cc_addrs),
        date: row.internal_date ?? new Date(0).toISOString(),
        seen: !!row.seen,
        flagged: !!row.flagged,
        hasAttachments: !!row.has_attachments,
        messageId: row.message_id ?? null,
      }))
      // Newest first from the RPC; render oldest→newest like a real thread.
      .reverse();

    return { ok: true, rows: mapped };
  });
