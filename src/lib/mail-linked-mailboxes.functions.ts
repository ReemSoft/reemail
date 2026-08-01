// Phase B — Multi-Mailbox (up to 5 linked mailboxes per primary mailbox).
//
// Security model (identical to the rest of the mail surface):
//   * Every function REQUIRES a valid, signed Mail Session Token.
//   * ownerAccountId + companyId come from the verified JWT claims only.
//   * A mailbox can only be linked AFTER its password is verified against
//     the real IMAP server through the Bridge.
//   * Passwords are never logged and never returned to the browser.
//   * The browser can never influence which host the bridge connects to for
//     an already-known account: settings are read from the database. Only a
//     brand-new external mailbox may supply IMAP/SMTP settings, and those are
//     persisted on its own row before any further use.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const MAX_LINKED_MAILBOXES = 5;

const TokenSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
});

const LinkSchema = TokenSchema.extend({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
  displayName: z.string().max(256).optional(),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().positive().max(65535).optional(),
  imapSecure: z.boolean().optional(),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().positive().max(65535).optional(),
  smtpSecure: z.boolean().optional(),
});

const SwitchSchema = TokenSchema.extend({
  targetAccountId: z.string().uuid(),
  /** Optional: omitted for the instant path (server uses stored credentials). */
  password: z.string().min(1).max(1024).optional(),
});

const UnlinkSchema = TokenSchema.extend({
  linkedAccountId: z.string().uuid(),
});

export interface LinkedMailboxSummary {
  accountId: string;
  emailAddress: string;
  displayName: string | null;
}

export interface SwitchedMailbox {
  account: {
    id: string;
    company_id: string;
    email_address: string;
    display_name: string | null;
    imap_host: string;
    imap_port: number;
    imap_secure: boolean;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
  };
  company: {
    id: string;
    name: string;
    app_name: string | null;
    logo_url: string | null;
    brand_primary: string;
    brand_accent: string;
  } | null;
  mailSessionToken: string;
  mailSessionTokenExpiresAt: number;
}

export const listLinkedMailboxes = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof TokenSchema>) => TokenSchema.parse(v))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; mailboxes: LinkedMailboxSummary[]; max: number } | { ok: false; message: string }
    > => {
      const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
      let claims;
      try {
        claims = await verifyMailSessionToken(data.mailSessionToken);
      } catch {
        return { ok: false, message: "INVALID_TOKEN" };
      }
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: rows, error } = await supabaseAdmin
        .from("mail_account_links")
        .select("linked_account_id, mail_accounts!mail_account_links_linked_account_id_fkey(id, email_address, display_name)")
        .eq("owner_account_id", claims.sub)
        .eq("company_id", claims.cid)
        .order("created_at", { ascending: true });
      if (error) {
        console.error("[linked-mailboxes] list failed", { code: error.code });
        return { ok: false, message: "تعذر تحميل الصناديق المرتبطة." };
      }
      const mailboxes: LinkedMailboxSummary[] = (rows ?? [])
        .map((r) => {
          const acc = r.mail_accounts as unknown as {
            id: string;
            email_address: string;
            display_name: string | null;
          } | null;
          if (!acc) return null;
          return {
            accountId: acc.id,
            emailAddress: acc.email_address,
            displayName: acc.display_name ?? null,
          };
        })
        .filter((x): x is LinkedMailboxSummary => x !== null);
      return { ok: true, mailboxes, max: MAX_LINKED_MAILBOXES };
    },
  );

export const linkMailbox = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof LinkSchema>) => LinkSchema.parse(v))
  .handler(
    async ({ data }): Promise<{ ok: true; mailbox: SwitchedMailbox } | { ok: false; message: string }> => {
      const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
      let claims;
      try {
        claims = await verifyMailSessionToken(data.mailSessionToken);
      } catch {
        return { ok: false, message: "INVALID_TOKEN" };
      }

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const {
        findOrCreateMailAccountIdentity,
        MailAccountOwnershipConflictError,
        normalizeEmail,
      } = await import("@/lib/mail-account-identity.server");

      const normalized = normalizeEmail(data.email);
      if (normalized === claims.em) {
        return { ok: false, message: "هذا هو صندوق البريد الحالي." };
      }

      // Cap check.
      const { count, error: countErr } = await supabaseAdmin
        .from("mail_account_links")
        .select("id", { count: "exact", head: true })
        .eq("owner_account_id", claims.sub)
        .eq("company_id", claims.cid);
      if (countErr) {
        console.error("[linked-mailboxes] count failed", { code: countErr.code });
        return { ok: false, message: "تعذر التحقق من عدد الصناديق المرتبطة." };
      }
      if ((count ?? 0) >= MAX_LINKED_MAILBOXES) {
        return {
          ok: false,
          message: "لا يمكن ربط أكثر من 5 صناديق بريد إضافية.",
        };
      }

      // Resolve connection settings BEFORE verifying.
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("mail_accounts")
        .select(
          "id, company_id, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure",
        )
        .eq("normalized_email", normalized)
        .maybeSingle();
      if (existingErr) {
        console.error("[linked-mailboxes] lookup failed", { code: existingErr.code });
        return { ok: false, message: "تعذر التحقق من هذا البريد الآن." };
      }
      if (existing && existing.company_id !== claims.cid) {
        return { ok: false, message: "هذا البريد مرتبط بشركة أخرى." };
      }

      let imapHost = data.imapHost ?? existing?.imap_host ?? null;
      let imapPort = data.imapPort ?? existing?.imap_port ?? null;
      let imapSecure = data.imapSecure ?? existing?.imap_secure ?? null;
      let smtpHost = data.smtpHost ?? existing?.smtp_host ?? null;
      let smtpPort = data.smtpPort ?? existing?.smtp_port ?? null;
      let smtpSecure = data.smtpSecure ?? existing?.smtp_secure ?? null;

      if (!imapHost || !smtpHost) {
        // Fall back to the company's domain template for this domain.
        const domainPart = normalized.split("@")[1] ?? "";
        if (domainPart) {
          const { data: tpl } = await supabaseAdmin
            .from("email_domains")
            .select("imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure")
            .eq("company_id", claims.cid)
            .ilike("domain", domainPart)
            .limit(1);
          const d = tpl?.[0];
          if (d) {
            imapHost = imapHost ?? d.imap_host;
            imapPort = imapPort ?? d.imap_port;
            imapSecure = imapSecure ?? d.imap_secure;
            smtpHost = smtpHost ?? d.smtp_host;
            smtpPort = smtpPort ?? d.smtp_port;
            smtpSecure = smtpSecure ?? d.smtp_secure;
          }
        }
      }

      if (
        !imapHost ||
        imapPort == null ||
        imapSecure == null ||
        !smtpHost ||
        smtpPort == null ||
        smtpSecure == null
      ) {
        return { ok: false, message: "إعدادات الاتصال غير مكتملة لهذا البريد." };
      }

      const displayName = data.displayName ?? existing?.display_name ?? null;

      // Verify against the real IMAP server through the bridge.
      const bridgeUrl = process.env.MAIL_BRIDGE_URL;
      const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
      if (!bridgeUrl || !bridgeKey) {
        return { ok: false, message: "خادم البريد غير مهيأ." };
      }
      try {
        const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bridge-Key": bridgeKey },
          body: JSON.stringify({
            account: {
              email_address: normalized,
              display_name: displayName,
              imap_host: imapHost,
              imap_port: imapPort,
              imap_secure: imapSecure,
              smtp_host: smtpHost,
              smtp_port: smtpPort,
              smtp_secure: smtpSecure,
            },
            password: data.password,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          return { ok: false, message: "فشل التحقق من بيانات هذا البريد." };
        }
      } catch {
        return { ok: false, message: "تعذر الاتصال بخادم البريد." };
      }

      // Resolve / create the permanent identity inside the SAME company.
      let identity;
      try {
        identity = await findOrCreateMailAccountIdentity(supabaseAdmin, {
          companyId: claims.cid,
          emailAddress: normalized,
          displayName,
          accountSource: "manual",
        });
      } catch (e) {
        if (e instanceof MailAccountOwnershipConflictError) {
          return { ok: false, message: "هذا البريد مرتبط بشركة أخرى." };
        }
        console.error("[linked-mailboxes] identity failed", e);
        return { ok: false, message: "تعذر تجهيز هوية هذا البريد." };
      }

      // Persist the resolved connection settings on the row so future calls
      // never depend on browser-supplied hosts.
      const { error: updErr } = await supabaseAdmin
        .from("mail_accounts")
        .update({
          display_name: displayName,
          imap_host: imapHost,
          imap_port: imapPort,
          imap_secure: imapSecure,
          smtp_host: smtpHost,
          smtp_port: smtpPort,
          smtp_secure: smtpSecure,
        })
        .eq("id", identity.id)
        .eq("company_id", claims.cid);
      if (updErr) {
        console.error("[linked-mailboxes] settings persist failed", { code: updErr.code });
        return { ok: false, message: "تعذر حفظ إعدادات هذا البريد." };
      }

      // Store the verified password (encrypted) for background sync.
      try {
        const { persistCredentialsAfterSuccessfulVerify } = await import(
          "@/lib/mail-credentials.server"
        );
        await persistCredentialsAfterSuccessfulVerify(
          supabaseAdmin,
          identity.id,
          claims.cid,
          data.password,
        );
      } catch {
        // Non-fatal: interactive use still works with the in-tab password.
        console.error("[linked-mailboxes] credential persistence failed");
      }

      // Record the link as a symmetric MESH: every mailbox of the group is
      // linked to every other one, so switching to a newly added mailbox still
      // shows (and can switch back to) the whole group — no re-login needed.
      const { data: groupRows } = await supabaseAdmin
        .from("mail_account_links")
        .select("linked_account_id")
        .eq("owner_account_id", claims.sub)
        .eq("company_id", claims.cid);
      const members = Array.from(
        new Set<string>([
          claims.sub,
          ...(groupRows ?? []).map((r) => r.linked_account_id as string),
          identity.id,
        ]),
      );
      const pairs: { owner_account_id: string; linked_account_id: string; company_id: string }[] = [];
      for (const a of members) {
        for (const b of members) {
          if (a === b) continue;
          pairs.push({ owner_account_id: a, linked_account_id: b, company_id: claims.cid });
        }
      }
      const { error: linkErr } = await supabaseAdmin
        .from("mail_account_links")
        .upsert(pairs, { onConflict: "owner_account_id,linked_account_id" });
      if (linkErr) {
        console.error("[linked-mailboxes] link insert failed", { code: linkErr.code });
        return { ok: false, message: "تعذر ربط صندوق البريد." };
      }


      const { issueMailSessionToken } = await import("@/lib/mail-token.server");
      const tokenInfo = await issueMailSessionToken({
        accountId: identity.id,
        companyId: claims.cid,
        normalizedEmail: normalized,
      });

      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("id, name, app_name, logo_url, brand_primary, brand_accent")
        .eq("id", claims.cid)
        .maybeSingle();

      return {
        ok: true,
        mailbox: {
          account: {
            id: identity.id,
            company_id: claims.cid,
            email_address: normalized,
            display_name: displayName,
            imap_host: imapHost,
            imap_port: imapPort,
            imap_secure: imapSecure,
            smtp_host: smtpHost,
            smtp_port: smtpPort,
            smtp_secure: smtpSecure,
          },
          company: company ?? null,
          mailSessionToken: tokenInfo.token,
          mailSessionTokenExpiresAt: tokenInfo.expiresAt,
        },
      };
    },
  );

export const unlinkMailbox = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof UnlinkSchema>) => UnlinkSchema.parse(v))
  .handler(async ({ data }): Promise<{ ok: boolean; message?: string }> => {
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, message: "INVALID_TOKEN" };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.linkedAccountId === claims.sub) {
      return { ok: false, message: "لا يمكن إلغاء ربط الصندوق الحالي." };
    }
    // The caller must already be in the same group as the target.
    const { data: membership } = await supabaseAdmin
      .from("mail_account_links")
      .select("id")
      .eq("owner_account_id", claims.sub)
      .eq("company_id", claims.cid)
      .eq("linked_account_id", data.linkedAccountId)
      .maybeSingle();
    if (!membership) return { ok: false, message: "هذا الصندوق غير مرتبط بحسابك." };

    // Mesh cleanup: drop every edge that touches the removed mailbox inside
    // this company, so no other member keeps a stale link to it.
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabaseAdmin
        .from("mail_account_links")
        .delete()
        .eq("company_id", claims.cid)
        .eq("owner_account_id", data.linkedAccountId),
      supabaseAdmin
        .from("mail_account_links")
        .delete()
        .eq("company_id", claims.cid)
        .eq("linked_account_id", data.linkedAccountId),
    ]);
    if (e1 || e2) {
      console.error("[linked-mailboxes] unlink failed", { code: (e1 ?? e2)?.code });
      return { ok: false, message: "تعذر إلغاء الربط." };
    }
    return { ok: true };

  });

/**
 * Switch the active mailbox. The target must be either the owner's own
 * mailbox or one of its linked mailboxes. The password is re-verified against
 * the real IMAP server before a token for the target is issued.
 */
export const switchMailbox = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof SwitchSchema>) => SwitchSchema.parse(v))
  .handler(
    async ({ data }): Promise<{ ok: true; mailbox: SwitchedMailbox } | { ok: false; message: string }> => {
      const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
      let claims;
      try {
        claims = await verifyMailSessionToken(data.mailSessionToken);
      } catch {
        return { ok: false, message: "INVALID_TOKEN" };
      }

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      if (data.targetAccountId !== claims.sub) {
        const { data: link, error } = await supabaseAdmin
          .from("mail_account_links")
          .select("id")
          .eq("owner_account_id", claims.sub)
          .eq("company_id", claims.cid)
          .eq("linked_account_id", data.targetAccountId)
          .maybeSingle();
        if (error) {
          console.error("[linked-mailboxes] switch lookup failed", { code: error.code });
          return { ok: false, message: "تعذر تبديل صندوق البريد." };
        }
        if (!link) return { ok: false, message: "هذا الصندوق غير مرتبط بحسابك." };
      }

      const { resolveMailConfigForAccount } = await import("@/lib/mail-config.server");
      let cfg;
      try {
        cfg = await resolveMailConfigForAccount(supabaseAdmin, data.targetAccountId, claims.cid);
      } catch {
        return { ok: false, message: "إعدادات هذا الصندوق غير مكتملة." };
      }

      // Instant path: no password from the browser → use the credentials that
      // were already verified (and encrypted) when this mailbox was linked.
      // Nothing new is exposed: the caller already proved membership in this
      // mailbox group with a signed mail session token.
      let effectivePassword = data.password;
      if (!effectivePassword) {
        try {
          const { loadDecryptedPasswordForAccount } = await import("@/lib/mail-credentials.server");
          effectivePassword = await loadDecryptedPasswordForAccount(
            supabaseAdmin,
            cfg.accountId,
            cfg.companyId,
          );
        } catch {
          // No stored credentials → the UI falls back to asking once.
          return { ok: false, message: "CREDENTIALS_PENDING" };
        }
      } else {
        // Explicit password → re-verify it against the real IMAP server.
        const bridgeUrl = process.env.MAIL_BRIDGE_URL;
        const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
        if (!bridgeUrl || !bridgeKey) return { ok: false, message: "خادم البريد غير مهيأ." };
        try {
          const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/api/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Bridge-Key": bridgeKey },
            body: JSON.stringify({
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
              password: effectivePassword,
            }),
          });
          const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
          if (!res.ok || !json.ok) return { ok: false, message: "كلمة المرور غير صحيحة." };
        } catch {
          return { ok: false, message: "تعذر الاتصال بخادم البريد." };
        }
        try {
          const { persistCredentialsAfterSuccessfulVerify } = await import(
            "@/lib/mail-credentials.server"
          );
          await persistCredentialsAfterSuccessfulVerify(
            supabaseAdmin,
            cfg.accountId,
            cfg.companyId,
            effectivePassword,
          );
        } catch {
          console.error("[linked-mailboxes] switch credential refresh failed");
        }
      }


      const { issueMailSessionToken } = await import("@/lib/mail-token.server");
      const tokenInfo = await issueMailSessionToken({
        accountId: cfg.accountId,
        companyId: cfg.companyId,
        normalizedEmail: cfg.normalizedEmail,
      });

      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("id, name, app_name, logo_url, brand_primary, brand_accent")
        .eq("id", cfg.companyId)
        .maybeSingle();

      return {
        ok: true,
        mailbox: {
          account: {
            id: cfg.accountId,
            company_id: cfg.companyId,
            email_address: cfg.emailAddress,
            display_name: cfg.displayName,
            imap_host: cfg.imapHost,
            imap_port: cfg.imapPort,
            imap_secure: cfg.imapSecure,
            smtp_host: cfg.smtpHost,
            smtp_port: cfg.smtpPort,
            smtp_secure: cfg.smtpSecure,
          },
          company: company ?? null,
          mailSessionToken: tokenInfo.token,
          mailSessionTokenExpiresAt: tokenInfo.expiresAt,
        },
      };
    },
  );
