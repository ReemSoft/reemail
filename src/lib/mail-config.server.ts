// Server-only. Resolves the full IMAP/SMTP config for a mail_accounts row
// by (accountId, companyId). Merges partial account overrides with the
// company's domain defaults from `email_domains`. Never called from the
// browser directly — always via a server function AFTER the mail session
// token has been verified.
import type { supabaseAdmin as SupabaseAdminType } from "@/integrations/supabase/client.server";

type Admin = typeof SupabaseAdminType;

export interface ResolvedMailConfig {
  accountId: string;
  companyId: string;
  emailAddress: string;
  normalizedEmail: string;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  sourceDomainId: string | null;
}

export class MailAccountNotFoundError extends Error {
  code = "MAIL_ACCOUNT_NOT_FOUND" as const;
  constructor() {
    super("MAIL_ACCOUNT_NOT_FOUND");
  }
}

export class MailAccountCompanyMismatchError extends Error {
  code = "MAIL_ACCOUNT_COMPANY_MISMATCH" as const;
  constructor() {
    super("MAIL_ACCOUNT_COMPANY_MISMATCH");
  }
}

export class MailConfigIncompleteError extends Error {
  code = "MAIL_CONFIG_INCOMPLETE" as const;
  constructor() {
    super("MAIL_CONFIG_INCOMPLETE");
  }
}

/**
 * Loads the mail account row and merges in domain defaults where the
 * per-account IMAP/SMTP fields are missing. Returns a fully-populated
 * config or throws a typed error.
 *
 * The company_id in the JWT claims is authoritative: even though the row is
 * fetched by primary key, we additionally filter by company_id so a caller
 * cannot use a stolen sub with a different cid.
 */
export async function resolveMailConfigForAccount(
  admin: Admin,
  accountId: string,
  companyId: string,
): Promise<ResolvedMailConfig> {
  const { data: acc, error } = await admin
    .from("mail_accounts")
    .select(
      "id, company_id, email_address, normalized_email, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, source_domain_id",
    )
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!acc) throw new MailAccountNotFoundError();
  if (acc.company_id !== companyId) throw new MailAccountCompanyMismatchError();

  let imapHost = acc.imap_host as string | null;
  let imapPort = acc.imap_port as number | null;
  let imapSecure = acc.imap_secure as boolean | null;
  let smtpHost = acc.smtp_host as string | null;
  let smtpPort = acc.smtp_port as number | null;
  let smtpSecure = acc.smtp_secure as boolean | null;

  const needsDomainFallback =
    !imapHost ||
    imapPort == null ||
    imapSecure == null ||
    !smtpHost ||
    smtpPort == null ||
    smtpSecure == null;

  if (needsDomainFallback) {
    const domainPart = (acc.email_address ?? "").split("@")[1]?.toLowerCase() ?? "";
    if (domainPart) {
      let q = admin
        .from("email_domains")
        .select("id, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure")
        .eq("company_id", companyId)
        .ilike("domain", domainPart);
      if (acc.source_domain_id) q = q.eq("id", acc.source_domain_id);
      const { data: rows } = await q.limit(1);
      const d = rows?.[0];
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
    throw new MailConfigIncompleteError();
  }

  return {
    accountId: acc.id,
    companyId: acc.company_id,
    emailAddress: acc.email_address,
    normalizedEmail: acc.normalized_email ?? (acc.email_address ?? "").toLowerCase().trim(),
    displayName: acc.display_name ?? null,
    imapHost,
    imapPort,
    imapSecure,
    smtpHost,
    smtpPort,
    smtpSecure,
    sourceDomainId: acc.source_domain_id ?? null,
  };
}
