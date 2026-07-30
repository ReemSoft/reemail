// Silent Mail Session renewal.
//
// The Mail Session Token is short-lived (12h). Before this module existed the
// only way to obtain a new one was a full sign-out / sign-in cycle, so any
// mail action after expiry failed with a misleading "connection" banner.
//
// Renewal contract:
//   * The (expired) token must still carry a VALID signature and identity
//     claims, and must not be older than the renewal window.
//   * The live IMAP password is re-verified against the real mail server via
//     the Bridge — a stale token alone can never mint a new session.
//   * Nothing about the password is logged.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type RenewMailSessionInput = z.input<typeof InputSchema>;

export type RenewMailSessionResult =
  | { ok: true; mailSessionToken: string; mailSessionTokenExpiresAt: number }
  | { ok: false; code: "INVALID_TOKEN" | "AUTH_FAILED" | "CONFIG" | "UNAVAILABLE" };

export const renewMailSession = createServerFn({ method: "POST" })
  .inputValidator((input: RenewMailSessionInput) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<RenewMailSessionResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionTokenAllowExpired, issueMailSessionToken } = await import(
      "@/lib/mail-token.server"
    );
    const { resolveMailConfigForAccount } = await import("@/lib/mail-config.server");

    let claims;
    try {
      claims = await verifyMailSessionTokenAllowExpired(data.mailSessionToken);
    } catch {
      return { ok: false, code: "INVALID_TOKEN" };
    }

    let cfg;
    try {
      cfg = await resolveMailConfigForAccount(supabaseAdmin, claims.sub, claims.cid);
    } catch {
      return { ok: false, code: "CONFIG" };
    }

    const bridgeUrl = process.env.MAIL_BRIDGE_URL;
    const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
    if (!bridgeUrl || !bridgeKey) return { ok: false, code: "UNAVAILABLE" };

    // Re-verify the password against the real IMAP server.
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
          password: data.password,
        }),
      });
      if (!res.ok) {
        // 401/403 → real credential failure; anything else → transient.
        return { ok: false, code: res.status === 401 || res.status === 403 ? "AUTH_FAILED" : "UNAVAILABLE" };
      }
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!json.ok) return { ok: false, code: "AUTH_FAILED" };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }

    try {
      const issued = await issueMailSessionToken({
        accountId: cfg.accountId,
        companyId: cfg.companyId,
        normalizedEmail: cfg.normalizedEmail,
      });
      return {
        ok: true,
        mailSessionToken: issued.token,
        mailSessionTokenExpiresAt: issued.expiresAt,
      };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  });
