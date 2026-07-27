// Server-only helper: given an accountId + companyId (already verified upstream),
// load the encrypted credentials, decrypt them, and call Bridge /api/verify to
// prove the round-trip end-to-end. Returns a boolean-plus-code result and NEVER
// includes the plaintext in the response or in any log line.
//
// Used by:
//   * the Phase-1 diagnostic server function `credentialRoundTripCheck`
//   * the Phase-2 background Worker (upcoming) to open IMAP without a
//     browser-supplied password.
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDecryptedPasswordForAccount, MailCredentialsPendingError } from "./mail-credentials.server";
import { resolveMailConfigForAccount } from "./mail-config.server";

export type ServerVerifyResult =
  | { ok: true; emailAddress: string }
  | { ok: false; code: "CREDENTIALS_PENDING" }
  | { ok: false; code: "IMAP_AUTH_FAILED"; httpStatus: number }
  | { ok: false; code: "BRIDGE_UNREACHABLE" }
  | { ok: false; code: "BRIDGE_NOT_CONFIGURED" }
  | { ok: false; code: "CONFIG_INCOMPLETE" }
  | { ok: false; code: "INTERNAL" };

export async function serverSideVerifyWithStoredCredentials(
  admin: SupabaseClient,
  accountId: string,
  companyId: string,
): Promise<ServerVerifyResult> {
  const bridgeUrl = process.env.MAIL_BRIDGE_URL;
  const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
  if (!bridgeUrl || !bridgeKey) return { ok: false, code: "BRIDGE_NOT_CONFIGURED" };

  let config;
  try {
    config = await resolveMailConfigForAccount(admin, accountId, companyId);
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "MAIL_CONFIG_INCOMPLETE") return { ok: false, code: "CONFIG_INCOMPLETE" };
    console.error("[server-verify] config resolution failed", { code: code ?? "UNKNOWN" });
    return { ok: false, code: "INTERNAL" };
  }

  let password: string;
  try {
    password = await loadDecryptedPasswordForAccount(admin, accountId, companyId);
  } catch (e) {
    if (e instanceof MailCredentialsPendingError) {
      return { ok: false, code: "CREDENTIALS_PENDING" };
    }
    console.error("[server-verify] decrypt failed", {
      code: (e as { code?: string } | null)?.code ?? "UNKNOWN",
    });
    return { ok: false, code: "INTERNAL" };
  }

  try {
    const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Key": bridgeKey },
      body: JSON.stringify({
        account: {
          email_address: config.emailAddress,
          display_name: config.displayName,
          imap_host: config.imapHost,
          imap_port: config.imapPort,
          imap_secure: config.imapSecure,
          smtp_host: config.smtpHost,
          smtp_port: config.smtpPort,
          smtp_secure: config.smtpSecure,
        },
        password,
      }),
    });
    // Zero the password reference ASAP (no strong guarantee in JS but signals intent).
    password = "";
    if (!res.ok) {
      return { ok: false, code: "IMAP_AUTH_FAILED", httpStatus: res.status };
    }
    let body: { ok?: boolean } = {};
    try {
      body = (await res.json()) as { ok?: boolean };
    } catch {
      /* ignore */
    }
    if (!body.ok) return { ok: false, code: "IMAP_AUTH_FAILED", httpStatus: res.status };
    return { ok: true, emailAddress: config.emailAddress };
  } catch (err) {
    console.error("[server-verify] bridge fetch threw", {
      msg: (err as Error)?.message?.slice(0, 120),
    });
    return { ok: false, code: "BRIDGE_UNREACHABLE" };
  }
}
