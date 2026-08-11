// Sender Folders — virtual filter folders over the Local Mail Index.
//
// Design contract (performance):
//   * Definitions live in `mail_sender_folders` and are read ONCE per session
//     (one tiny SELECT, at most a few rows). They are never polled.
//   * Opening a sender folder is a single indexed SELECT over `mail_messages`
//     restricted to the account's INBOX folder row — exactly the same cost
//     profile as opening the Inbox itself. The Bridge / IMAP is never touched.
//   * Nothing here mutates mail state: no move, no delete, no flag change.
//
// Auth model matches indexListMessages: the caller sends the short-lived Mail
// Session Token; identity (accountId, companyId) comes from verified claims.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailMessage } from "@/lib/mail-types";

export interface SenderFolder {
  id: string;
  email: string;
  name: string;
  color: string;
}

const TokenSchema = z.string().min(20).max(4096);
const EmailSchema = z.string().trim().toLowerCase().min(3).max(320);

const ListInput = z.object({ mailSessionToken: TokenSchema }).strict();

const SaveInput = z
  .object({
    mailSessionToken: TokenSchema,
    email: EmailSchema,
    name: z.string().trim().max(120).default(""),
    color: z.string().trim().min(1).max(24).default("blue"),
  })
  .strict();

const DeleteInput = z.object({ mailSessionToken: TokenSchema, email: EmailSchema }).strict();

const MessagesInput = z
  .object({
    mailSessionToken: TokenSchema,
    email: EmailSchema,
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export type SenderFolderListResult =
  | { ok: true; folders: SenderFolder[] }
  | { ok: false; error: string; code: string };

export type SenderFolderMessagesResult =
  | { ok: true; messages: MailMessage[]; nextCursor: string | null; hasMore: boolean }
  | { ok: false; error: string; code: string };

async function auth(token: string) {
  const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
  const claims = await verifyMailSessionToken(token);
  return { accountId: claims.sub, companyId: claims.cid };
}

const INVALID = { ok: false as const, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };

export const listSenderFolders = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof ListInput>) => ListInput.parse(input))
  .handler(async ({ data }): Promise<SenderFolderListResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let who;
    try {
      who = await auth(data.mailSessionToken);
    } catch {
      return INVALID;
    }
    const q = await supabaseAdmin
      .from("mail_sender_folders")
      .select("id, sender_email, display_name, color")
      .eq("account_id", who.accountId)
      .eq("company_id", who.companyId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (q.error) {
      console.error("[listSenderFolders] query failed", q.error);
      return { ok: false, error: "تعذر قراءة المجلدات.", code: "QUERY_FAILED" };
    }
    return {
      ok: true,
      folders: (q.data ?? []).map((r) => ({
        id: r.id,
        email: r.sender_email,
        name: r.display_name || r.sender_email,
        color: r.color || "blue",
      })),
    };
  });

export const saveSenderFolder = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof SaveInput>) => SaveInput.parse(input))
  .handler(async ({ data }): Promise<SenderFolderListResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let who;
    try {
      who = await auth(data.mailSessionToken);
    } catch {
      return INVALID;
    }
    const q = await supabaseAdmin
      .from("mail_sender_folders")
      .upsert(
        {
          account_id: who.accountId,
          company_id: who.companyId,
          sender_email: data.email,
          display_name: data.name || data.email,
          color: data.color,
        },
        { onConflict: "account_id,sender_email" },
      )
      .select("id, sender_email, display_name, color")
      .maybeSingle();
    if (q.error || !q.data) {
      console.error("[saveSenderFolder] upsert failed", q.error);
      return { ok: false, error: "تعذر حفظ المجلد.", code: "SAVE_FAILED" };
    }
    return {
      ok: true,
      folders: [
        {
          id: q.data.id,
          email: q.data.sender_email,
          name: q.data.display_name || q.data.sender_email,
          color: q.data.color || "blue",
        },
      ],
    };
  });

export const deleteSenderFolder = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof DeleteInput>) => DeleteInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let who;
    try {
      who = await auth(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية." };
    }
    const q = await supabaseAdmin
      .from("mail_sender_folders")
      .delete()
      .eq("account_id", who.accountId)
      .eq("company_id", who.companyId)
      .eq("sender_email", data.email);
    if (q.error) {
      console.error("[deleteSenderFolder] delete failed", q.error);
      return { ok: false, error: "تعذر حذف المجلد." };
    }
    return { ok: true };
  });

/**
 * One page of Inbox messages sent by a given address. Pure read over the
 * already-synced Local Mail Index — zero Bridge/IMAP work.
 */
export const listSenderMessages = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof MessagesInput>) => MessagesInput.parse(input))
  .handler(async ({ data }): Promise<SenderFolderMessagesResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { indexRowToMailMessage, encodeIndexCursor, decodeIndexCursor } = await import(
      "@/lib/mail-index-row"
    );
    let who;
    try {
      who = await auth(data.mailSessionToken);
    } catch {
      return INVALID;
    }

    const folderQ = await supabaseAdmin
      .from("mail_folders")
      .select("id, uidvalidity")
      .eq("account_id", who.accountId)
      .eq("company_id", who.companyId)
      .eq("canonical", "inbox")
      .maybeSingle();
    if (folderQ.error || !folderQ.data) {
      return { ok: false, error: "المجلد غير جاهز بعد.", code: "NO_FOLDER" };
    }

    const cursor = data.cursor ? decodeIndexCursor(data.cursor) : null;
    const limit = data.limit;
    const rpc = await supabaseAdmin.rpc("list_mail_sender_messages", {
      _company_id: who.companyId,
      _account_id: who.accountId,
      _folder_id: folderQ.data.id,
      _sender: data.email,
      _limit: limit + 1,
      _cursor_date: cursor?.date ?? undefined,
      _cursor_id: cursor?.id ?? undefined,
    });
    if (rpc.error) {
      console.error("[listSenderMessages] rpc failed", rpc.error);
      return { ok: false, error: "تعذر قراءة الرسائل.", code: "PAGE_QUERY_FAILED" };
    }
    const rows = rpc.data ?? [];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const uidValidity =
      folderQ.data.uidvalidity != null ? String(folderQ.data.uidvalidity) : undefined;

    const messages = pageRows.map((r) => ({
      ...indexRowToMailMessage("inbox", {
        uid: Number(r.uid),
        subject: r.subject,
        from_addr: r.from_addr,
        to_addrs: r.to_addrs,
        cc_addrs: r.cc_addrs,
        internal_date: r.internal_date,
        seen: !!r.seen,
        flagged: !!r.flagged,
        has_attachments: !!r.has_attachments,
        message_id: r.message_id,
        in_reply_to: r.in_reply_to,
        references_ids: r.references_ids ?? [],
      }),
      uidValidity,
    }));

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last && last.internal_date
        ? encodeIndexCursor({ date: last.internal_date, id: String(last.id) })
        : null;

    return { ok: true, messages, nextCursor, hasMore };
  });
