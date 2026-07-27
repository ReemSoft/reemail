// Server-only. Shared verification + config resolution for every server
// function/route that proxies to the private Mail Bridge.
//
// Enforces the same trust model as `indexMoveMessage` / `indexDeleteMessage`:
//   * accountId + companyId come from the verified Mail Session JWT claims
//   * IMAP/SMTP host/port/security are ALWAYS loaded from the database via
//     `resolveMailConfigForAccount` — never taken from the browser
//
// This closes the "bridge passthrough" SSRF/open-relay hole where the
// legacy bridge functions accepted arbitrary `account` fields from the
// client and forwarded them to the bridge under the server's trusted key.
import { verifyMailSessionToken } from "@/lib/mail-token.server";
import {
  resolveMailConfigForAccount,
  MailAccountNotFoundError,
  MailAccountCompanyMismatchError,
  MailConfigIncompleteError,
  type ResolvedMailConfig,
} from "@/lib/mail-config.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface BridgeAuthOk {
  ok: true;
  accountId: string;
  companyId: string;
  cfg: ResolvedMailConfig;
  bridgeAccount: {
    email_address: string;
    display_name: string | null;
    imap_host: string;
    imap_port: number;
    imap_secure: boolean;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
  };
  bridgeUrl: string;
  bridgeKey: string;
}
export interface BridgeAuthErr {
  ok: false;
  status: number;
  error: string;
  code: string;
}

export async function resolveBridgeAuth(
  mailSessionToken: string,
): Promise<BridgeAuthOk | BridgeAuthErr> {
  let claims;
  try {
    claims = await verifyMailSessionToken(mailSessionToken);
  } catch {
    return {
      ok: false,
      status: 401,
      error: "جلسة البريد غير صالحة أو منتهية.",
      code: "INVALID_TOKEN",
    };
  }
  const accountId = claims.sub;
  const companyId = claims.cid;

  let cfg: ResolvedMailConfig;
  try {
    cfg = await resolveMailConfigForAccount(supabaseAdmin, accountId, companyId);
  } catch (e) {
    if (e instanceof MailAccountNotFoundError)
      return { ok: false, status: 404, error: "الحساب غير موجود.", code: e.code };
    if (e instanceof MailAccountCompanyMismatchError)
      return { ok: false, status: 403, error: "تعارض هوية الحساب.", code: e.code };
    if (e instanceof MailConfigIncompleteError)
      return { ok: false, status: 409, error: "إعدادات البريد غير مكتملة.", code: e.code };
    console.error("[resolveBridgeAuth] resolveConfig failed", e);
    return { ok: false, status: 500, error: "تعذر تحميل الإعدادات.", code: "CONFIG_LOAD_FAILED" };
  }

  const bridgeUrl = process.env.MAIL_BRIDGE_URL;
  const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
  if (!bridgeUrl || !bridgeKey) {
    return {
      ok: false,
      status: 503,
      error: "لم يتم ربط خادم البريد.",
      code: "BRIDGE_NOT_CONFIGURED",
    };
  }

  return {
    ok: true,
    accountId,
    companyId,
    cfg,
    bridgeAccount: {
      email_address: cfg.emailAddress,
      display_name: cfg.displayName,
      imap_host: cfg.imapHost,
      imap_port: cfg.imapPort,
      imap_secure: cfg.imapSecure,
      smtp_host: cfg.smtpHost,
      smtp_port: cfg.smtpPort,
      smtp_secure: cfg.smtpSecure,
    },
    bridgeUrl: bridgeUrl.replace(/\/$/, ""),
    bridgeKey,
  };
}
