// Server function that owns a "flag mutation with local-index write-through".
//
// Flow:
//   1) Verify Mail Session Token (JWT). accountId + companyId come from
//      verified claims — client cannot forge identity.
//   2) Resolve full IMAP config from DB (mail_accounts + email_domains).
//   3) Call the Bridge to mutate IMAP (\Seen or \Flagged).
//   4) On IMAP success, update mail_messages.{seen|flagged} locally,
//      matched by (account_id, folder_id, uidvalidity, uid). Refresh the
//      folder's unread count when seen changed.
//   5) On IMAP success + DB failure: DO NOT rollback the UI. IMAP is the
//      source of truth; mark flags_need_reconcile=true so the next scheduled
//      reconcile fixes the index.
//
// Client-safe: all server-only imports are dynamic (inside the handler).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const CanonicalSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
    canonical: CanonicalSchema,
    uid: z.number().int().positive(),
    kind: z.enum(["seen", "flagged"]),
    value: z.boolean(),
  })
  .strict();

export type IndexUpdateFlagInput = z.input<typeof InputSchema>;

export type IndexUpdateFlagResult =
  | { ok: true; imap: true; index: "updated" | "partial" | "no-folder" }
  | { ok: false; error: string; code: string };

export const indexUpdateFlag = createServerFn({ method: "POST" })
  .inputValidator((v: IndexUpdateFlagInput) => InputSchema.parse(v))
  .handler(async ({ data }): Promise<IndexUpdateFlagResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const {
      resolveMailConfigForAccount,
      MailAccountNotFoundError,
      MailAccountCompanyMismatchError,
      MailConfigIncompleteError,
    } = await import("@/lib/mail-config.server");

    // 1) Verify JWT
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }
    const accountId = claims.sub;
    const companyId = claims.cid;

    // 2) Resolve config
    let cfg;
    try {
      cfg = await resolveMailConfigForAccount(supabaseAdmin, accountId, companyId);
    } catch (e) {
      if (e instanceof MailAccountNotFoundError)
        return { ok: false, error: "الحساب غير موجود.", code: e.code };
      if (e instanceof MailAccountCompanyMismatchError)
        return { ok: false, error: "تعارض هوية الحساب.", code: e.code };
      if (e instanceof MailConfigIncompleteError)
        return { ok: false, error: "إعدادات البريد غير مكتملة.", code: e.code };
      console.error("[indexUpdateFlag] resolveConfig failed", e);
      return { ok: false, error: "تعذر تحميل الإعدادات.", code: "CONFIG_LOAD_FAILED" };
    }

    // 3) Mutate IMAP via Bridge (canonical folder name; bridge resolves path)
    const url = process.env.MAIL_BRIDGE_URL;
    const key = process.env.MAIL_BRIDGE_SECRET;
    if (!url || !key) {
      return { ok: false, error: "لم يتم ربط خادم البريد.", code: "BRIDGE_NOT_CONFIGURED" };
    }
    const path = data.kind === "seen" ? "/api/mark-read" : "/api/star";
    const bridgeBody: Record<string, unknown> = {
      account: {
        email_address: cfg.emailAddress,
        display_name: cfg.displayName,
        imap_host: cfg.imapHost,
        imap_port: cfg.imapPort,
        imap_secure: cfg.imapSecure,
        smtp_host: cfg.smtpHost,
        smtp_port: cfg.smtpPort,
        smtp_secure: cfg.smtpSecure,
      },
      password: data.password,
      folder: data.canonical,
      uid: data.uid,
    };
    if (data.kind === "seen") bridgeBody.read = data.value;
    else bridgeBody.starred = data.value;

    try {
      const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
        body: JSON.stringify(bridgeBody),
      });
      const jsonText = await res.text();
      let j: { ok?: boolean; error?: string } = {};
      try {
        j = JSON.parse(jsonText);
      } catch {
        /* not JSON */
      }
      if (!res.ok || !j.ok) {
        const msg = j.error || `Bridge error ${res.status}`;
        return { ok: false, error: msg, code: "BRIDGE_MUTATION_FAILED" };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Bridge unreachable";
      return { ok: false, error: msg, code: "BRIDGE_UNREACHABLE" };
    }

    // 4) Local index write-through. Best-effort.
    let folderId: string | null = null;
    try {
      const fq = await supabaseAdmin
        .from("mail_folders")
        .select("id, uidvalidity")
        .eq("account_id", accountId)
        .eq("company_id", companyId)
        .eq("canonical", data.canonical)
        .maybeSingle();
      if (fq.error) throw fq.error;
      if (!fq.data?.id || fq.data.uidvalidity == null) {
        // Folder not yet indexed — nothing to write.
        return { ok: true, imap: true, index: "no-folder" };
      }
      folderId = fq.data.id;
      const uv = Number(fq.data.uidvalidity);

      const patch: Record<string, unknown> = {};
      if (data.kind === "seen") patch.seen = data.value;
      else patch.flagged = data.value;

      const up = await supabaseAdmin
        .from("mail_messages")
        .update(patch as never)
        .eq("account_id", accountId)
        .eq("folder_id", folderId)
        .eq("uidvalidity", uv)
        .eq("uid", data.uid);
      if (up.error) throw up.error;

      // Refresh unread count on seen changes only (cheap head count).
      if (data.kind === "seen") {
        const unreadQ = await supabaseAdmin
          .from("mail_messages")
          .select("*", { count: "exact", head: true })
          .eq("account_id", accountId)
          .eq("folder_id", folderId)
          .eq("uidvalidity", uv)
          .is("deleted_at", null)
          .eq("seen", false);
        if (!unreadQ.error) {
          await supabaseAdmin
            .from("mail_folders")
            .update({ unread: unreadQ.count ?? 0 })
            .eq("id", folderId);
        }
      }
      return { ok: true, imap: true, index: "updated" };
    } catch (e) {
      console.error("[indexUpdateFlag] index update failed after IMAP success", e);
      // Mark folder for reconcile so IMAP truth is applied on next round.
      if (folderId) {
        await supabaseAdmin
          .from("mail_sync_state")
          .update({ flags_need_reconcile: true })
          .eq("account_id", accountId)
          .eq("folder_id", folderId);
      }
      return { ok: true, imap: true, index: "partial" };
    }
  });
