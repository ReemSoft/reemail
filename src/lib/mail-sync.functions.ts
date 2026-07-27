// Server function that owns one Local Mail Index sync round:
//   Mail Session Token + password  →  DB config  →  Bridge sync  →  DB writes.
//
// Authentication: the caller passes their short-lived signed Mail Session
// Token in the request body. The token is verified with the server-only
// MAIL_SESSION_SECRET (jose HS256). accountId + companyId are read from the
// verified claims — the client cannot forge identity by editing the body.
//
// Concurrency: an atomic advisory-style lock in mail_sync_state prevents two
// syncs from racing on the same (account, folder).
//
// This module is client-safe by construction: every server-only import lives
// inside the handler, so the module can sit on the client bundle graph
// without leaking the service-role client or JWT secret.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AccountShape = z.object({
  email_address: z.string().email().max(320),
  display_name: z.string().nullable().optional(),
  imap_host: z.string().min(1).max(255),
  imap_port: z.number().int().positive().max(65535),
  imap_secure: z.boolean(),
  smtp_host: z.string().min(1).max(255),
  smtp_port: z.number().int().positive().max(65535),
  smtp_secure: z.boolean(),
});

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
    folderPath: z.string().min(1).max(500).default("INBOX"),
    canonical: z.string().min(1).max(32).optional(),
    mode: z.enum(["initial", "incremental", "reconcile"]),
    limit: z.number().int().positive().max(300).optional(),
    // reconcile-only
    fromUid: z.number().int().positive().optional(),
    toUid: z.number().int().positive().optional(),
    // incremental-only flag delta window (overrides state-derived range)
    flagsFromUid: z.number().int().positive().optional(),
    flagsToUid: z.number().int().positive().optional(),
  })
  .strict();

export type RunMailSyncInput = z.input<typeof InputSchema>;

export type RunMailSyncResult =
  | {
      ok: true;
      busy: false;
      mode: "initial" | "incremental" | "reconcile";
      folderId: string;
      folderPath: string;
      wroteMessages: number;
      appliedFlagChanges: number;
      tombstoned: number;
      wipedForUidValidity: boolean;
      total: number;
      unread: number;
      uidvalidity: string;
      newestSyncedUid: number | null;
      oldestSyncedUid: number | null;
      hasMore: boolean;
      flagsSync: "condstore" | "reconcile-required" | "not-requested";
    }
  | { ok: true; busy: true; reason: "LOCKED" }
  | { ok: false; error: string; code: string };

export const runMailSync = createServerFn({ method: "POST" })
  .inputValidator((input: RunMailSyncInput) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<RunMailSyncResult> => {
    // ---- server-only imports (kept out of the client bundle) ----
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const {
      resolveMailConfigForAccount,
      MailAccountNotFoundError,
      MailAccountCompanyMismatchError,
      MailConfigIncompleteError,
    } = await import("@/lib/mail-config.server");
    const { runMailSyncCore } = await import("@/lib/mail-sync-runner.server");

    // ---- 1) Verify token ----
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }
    const accountId = claims.sub;
    const companyId = claims.cid;

    // ---- 2) Resolve config ----
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
      console.error("[runMailSync] resolveConfig failed", e);
      return { ok: false, error: "تعذر تحميل إعدادات البريد.", code: "CONFIG_LOAD_FAILED" };
    }

    const bridgeAccount = AccountShape.parse({
      email_address: cfg.emailAddress,
      display_name: cfg.displayName,
      imap_host: cfg.imapHost,
      imap_port: cfg.imapPort,
      imap_secure: cfg.imapSecure,
      smtp_host: cfg.smtpHost,
      smtp_port: cfg.smtpPort,
      smtp_secure: cfg.smtpSecure,
    });

    // ---- 3) Delegate to the reusable core ----
    return runMailSyncCore(supabaseAdmin, {
      accountId,
      companyId,
      bridgeAccount,
      password: data.password,
      folderPath: data.folderPath,
      canonical: data.canonical ?? null,
      mode: data.mode,
      limit: data.limit,
      fromUid: data.fromUid,
      toUid: data.toUid,
      flagsFromUid: data.flagsFromUid,
      flagsToUid: data.flagsToUid,
    });
  });
