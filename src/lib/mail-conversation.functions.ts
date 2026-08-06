import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailMessage } from "@/lib/mail-types";

const InputSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  canonical: z.enum(["inbox", "starred", "sent", "drafts", "spam", "trash", "archive", "all"]),
  uid: z.number().int().positive(),
});

export type MailConversationResult =
  | { ok: true; messages: MailMessage[] }
  | { ok: false; messages: []; error: string };

export const getMailConversation = createServerFn({ method: "POST" })
  .inputValidator((value: z.input<typeof InputSchema>) => InputSchema.parse(value))
  .handler(async ({ data }): Promise<MailConversationResult> => {
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { indexRowToMailMessage } = await import("@/lib/mail-index-row");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok) return { ok: false, messages: [], error: auth.error };

    const result = await supabaseAdmin.rpc("get_mail_conversation", {
      _company_id: auth.companyId,
      _account_id: auth.accountId,
      _canonical: data.canonical,
      _uid: data.uid,
      _limit: 50,
    });
    if (result.error) {
      console.error("[getMailConversation] query failed", result.error);
      return { ok: false, messages: [], error: "تعذر تحميل المحادثة." };
    }

    const messages = (result.data ?? []).map((row) => {
      const canonical = row.canonical as MailMessage["folder"];
      return {
        ...indexRowToMailMessage(canonical, {
          uid: Number(row.uid),
          subject: row.subject,
          from_addr: row.from_addr,
          to_addrs: row.to_addrs,
          cc_addrs: row.cc_addrs,
          internal_date: row.internal_date,
          seen: !!row.seen,
          flagged: !!row.flagged,
          has_attachments: !!row.has_attachments,
          message_id: row.message_id,
          in_reply_to: row.in_reply_to,
        }),
        uidValidity: row.uidvalidity == null ? undefined : String(row.uidvalidity),
      };
    });
    return { ok: true, messages };
  });