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

    // 4) Local index write-through. Best-effort — IMAP already succeeded.
    //    All DB operations live in `mail-flags-writer.server.ts` so they can
    //    be exercised under unit tests with a mocked Supabase client.
    const {
      resolveFolderForFlag,
      updateMessageFlag,
      recomputeFolderUnread,
      markFolderNeedsFlagReconcile,
    } = await import("./mail-flags-writer.server");
    let folderId: string | null = null;
    try {
      // V4: "starred" is a virtual view over INBOX (\Flagged). The Local
      // Index only stores an INBOX row for this UID, so the write-through
      // MUST target `inbox` — otherwise `resolveFolderForFlag` returns null
      // and the DB `flagged` column stays stale forever. The Bridge call
      // above still uses the raw canonical name because the Bridge selects
      // the mailbox path from it.
      const indexCanonical = data.canonical === "starred" ? "inbox" : data.canonical;
      const folder = await resolveFolderForFlag(
        supabaseAdmin,
        accountId,
        companyId,
        indexCanonical,
      );
      if (!folder) {
        // Folder not yet indexed — nothing to write.
        return { ok: true, imap: true, index: "no-folder" };
      }
      folderId = folder.id;
      await updateMessageFlag(supabaseAdmin, {
        accountId,
        folderId: folder.id,
        uidvalidity: folder.uidvalidity,
        uid: data.uid,
        kind: data.kind,
        value: data.value,
      });
      if (data.kind === "seen") {
        // Best-effort unread recount — do not fail the whole write on this.
        try {
          await recomputeFolderUnread(supabaseAdmin, {
            accountId,
            folderId: folder.id,
            uidvalidity: folder.uidvalidity,
          });
        } catch (e) {
          console.error("[indexUpdateFlag] unread recount failed", e);
        }
      }
      return { ok: true, imap: true, index: "updated" };
    } catch (e) {
      console.error("[indexUpdateFlag] index update failed after IMAP success", e);
      if (folderId) {
        try {
          await markFolderNeedsFlagReconcile(supabaseAdmin, { accountId, folderId });
        } catch (mErr) {
          console.error("[indexUpdateFlag] failed to mark flags_need_reconcile", mErr);
        }
      }
      return { ok: true, imap: true, index: "partial" };
    }
  });
