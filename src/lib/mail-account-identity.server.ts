// Server-only. Resolves or creates a permanent mail_accounts row after a
// successful IMAP verify. Never accepts trust-worthy identity from the browser
// (all inputs must already be resolved from Supabase inside the server).
import type { supabaseAdmin as SupabaseAdminType } from "@/integrations/supabase/client.server";

export function normalizeEmail(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

export type MailAccountSource = "manual" | "domain";

export interface FindOrCreateInput {
  companyId: string;
  emailAddress: string;
  displayName?: string | null;
  sourceDomainId?: string | null;
  accountSource: MailAccountSource;
}

export interface MailAccountIdentity {
  id: string;
  companyId: string;
  emailAddress: string;
  normalizedEmail: string;
  sourceDomainId: string | null;
}

export class MailAccountOwnershipConflictError extends Error {
  code = "MAIL_ACCOUNT_OWNERSHIP_CONFLICT" as const;
  constructor() {
    super("MAIL_ACCOUNT_OWNERSHIP_CONFLICT");
  }
}

export class MailAccountSourceMismatchError extends Error {
  code = "MAIL_ACCOUNT_SOURCE_MISMATCH" as const;
  constructor() {
    super("MAIL_ACCOUNT_SOURCE_MISMATCH");
  }
}

type Admin = typeof SupabaseAdminType;

async function readByNormalizedEmail(admin: Admin, normalized: string) {
  const { data, error } = await admin
    .from("mail_accounts")
    .select("id, company_id, email_address, normalized_email, source_domain_id")
    .eq("normalized_email", normalized)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Resolve or create the permanent UUID identity for a mailbox.
 * MUST be called only AFTER Bridge /api/verify succeeded.
 * Never persists the password.
 */
export async function findOrCreateMailAccountIdentity(
  admin: Admin,
  input: FindOrCreateInput,
): Promise<MailAccountIdentity> {
  const normalized = normalizeEmail(input.emailAddress);
  if (!normalized || !normalized.includes("@")) {
    throw new Error("Invalid email");
  }
  if (!input.companyId) throw new Error("companyId required");

  const existing = await readByNormalizedEmail(admin, normalized);
  if (existing) {
    if (existing.company_id !== input.companyId) {
      // Do not reassign ownership across companies; do not leak the other one.
      throw new MailAccountOwnershipConflictError();
    }
    // Same company: verify source_domain_id compatibility.
    if (
      input.accountSource === "domain" &&
      input.sourceDomainId &&
      existing.source_domain_id &&
      existing.source_domain_id !== input.sourceDomainId
    ) {
      throw new MailAccountSourceMismatchError();
    }
    return {
      id: existing.id,
      companyId: existing.company_id,
      emailAddress: existing.email_address,
      normalizedEmail: existing.normalized_email ?? normalized,
      sourceDomainId: existing.source_domain_id ?? null,
    };
  }

  // Insert a new row. normalized_email is a generated STORED column, do not set it.
  const insertRow = {
    company_id: input.companyId,
    email_address: normalized,
    display_name: input.displayName ?? null,
    source_domain_id: input.accountSource === "domain" ? (input.sourceDomainId ?? null) : null,
  };

  const { data: inserted, error: insertErr } = await admin
    .from("mail_accounts")
    .insert(insertRow)
    .select("id, company_id, email_address, normalized_email, source_domain_id")
    .maybeSingle();

  if (insertErr) {
    // Handle race: unique(normalized_email) collision -> re-read.
    const isUniqueViolation =
      (insertErr as { code?: string }).code === "23505" ||
      /duplicate key|unique/i.test(insertErr.message ?? "");
    if (isUniqueViolation) {
      const again = await readByNormalizedEmail(admin, normalized);
      if (again) {
        if (again.company_id !== input.companyId) {
          throw new MailAccountOwnershipConflictError();
        }
        return {
          id: again.id,
          companyId: again.company_id,
          emailAddress: again.email_address,
          normalizedEmail: again.normalized_email ?? normalized,
          sourceDomainId: again.source_domain_id ?? null,
        };
      }
    }
    throw insertErr;
  }

  if (!inserted) throw new Error("Insert returned no row");
  return {
    id: inserted.id,
    companyId: inserted.company_id,
    emailAddress: inserted.email_address,
    normalizedEmail: inserted.normalized_email ?? normalized,
    sourceDomainId: inserted.source_domain_id ?? null,
  };
}
