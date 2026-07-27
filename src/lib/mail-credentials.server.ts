// Server-only. Persists/reads encrypted mail account credentials.
//
// All functions take a service-role Supabase admin client. They MUST NOT be
// reachable from a browser bundle — the `.server.ts` suffix triggers the
// project's client-import guard.
//
// Design:
//   * `persistCredentialsAfterSuccessfulVerify` is called ONLY after a
//     successful IMAP verify. It encrypts the plaintext password and writes
//     it to the account row along with the key version and a fresh timestamp.
//   * `loadDecryptedPasswordForAccount` is used by trusted server paths
//     (background worker, server functions) to obtain the plaintext needed
//     to open IMAP/SMTP without a browser round-trip.
//   * `clearCredentialsForAccount` wipes the ciphertext (used on delete /
//     explicit disconnect flows). We keep the row shape intact but set
//     ciphertext & version to NULL — the row becomes `credentials_pending`.
//   * On any failure path from encryption/persistence, we log the code but
//     never the plaintext / ciphertext / master key material.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptCredential, encryptCredential, MailCryptoError } from "./mail-crypto.server";

export type CredentialStatus = "active" | "pending";

export interface CredentialRow {
  status: CredentialStatus;
  keyVersion: number | null;
  updatedAt: string | null;
}

type Admin = Pick<SupabaseClient, "from" | "rpc">;

export class MailCredentialsPersistError extends Error {
  code = "MAIL_CREDENTIALS_PERSIST_FAILED" as const;
  constructor() {
    super("MAIL_CREDENTIALS_PERSIST_FAILED");
  }
}

export class MailCredentialsPendingError extends Error {
  code = "MAIL_CREDENTIALS_PENDING" as const;
  constructor() {
    super("MAIL_CREDENTIALS_PENDING");
  }
}

/**
 * Encrypt and persist the mail password for an account after a successful
 * IMAP verify. Idempotent: replaces any prior ciphertext atomically.
 *
 * Never called with an unverified password.
 */
export async function persistCredentialsAfterSuccessfulVerify(
  admin: Admin,
  accountId: string,
  companyId: string,
  plaintextPassword: string,
): Promise<{ keyVersion: number }> {
  let ciphertext: string;
  let keyVersion: number;
  try {
    const enc = await encryptCredential(admin, plaintextPassword);
    ciphertext = enc.ciphertext;
    keyVersion = enc.keyVersion;
  } catch (err) {
    // Log only the error code; never the plaintext or key material.
    const code = err instanceof MailCryptoError ? err.code : "MAIL_CRYPTO_UNKNOWN";
    console.error("[mail-credentials] encrypt failed", { code });
    throw new MailCredentialsPersistError();
  }
  const { error } = await admin
    .from("mail_accounts")
    .update({
      credentials_ciphertext: ciphertext,
      credentials_key_version: keyVersion,
      credentials_updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("company_id", companyId);
  if (error) {
    // supabase-js errors do not contain plaintext but may contain SQL detail.
    console.error("[mail-credentials] persist failed", { code: error.code });
    throw new MailCredentialsPersistError();
  }
  return { keyVersion };
}

/**
 * Load and decrypt the mail password for an account. Used by trusted server
 * paths (background worker, server fns) to open IMAP/SMTP without a browser
 * password. Throws MailCredentialsPendingError when the account has no
 * ciphertext yet — caller must surface `credentials_pending` to skip the
 * job / return an actionable error.
 */
export async function loadDecryptedPasswordForAccount(
  admin: Admin,
  accountId: string,
  companyId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("mail_accounts")
    .select("credentials_ciphertext, credentials_key_version")
    .eq("id", accountId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) {
    console.error("[mail-credentials] load failed", { code: error.code });
    throw new MailCredentialsPersistError();
  }
  if (!data || !data.credentials_ciphertext || data.credentials_key_version == null) {
    throw new MailCredentialsPendingError();
  }
  return decryptCredential(admin, data.credentials_ciphertext);
}

/**
 * Read only the status (without touching the ciphertext). Safe to surface to
 * the dashboard / UI.
 */
export async function readCredentialStatus(
  admin: Admin,
  accountId: string,
  companyId: string,
): Promise<CredentialRow> {
  const { data, error } = await admin
    .from("mail_accounts")
    .select("credentials_ciphertext, credentials_key_version, credentials_updated_at")
    .eq("id", accountId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.credentials_ciphertext) {
    return { status: "pending", keyVersion: null, updatedAt: null };
  }
  return {
    status: "active",
    keyVersion: data.credentials_key_version,
    updatedAt: data.credentials_updated_at,
  };
}

/**
 * Wipe the ciphertext. Called on account disconnect / delete pathways when
 * the row itself is being kept. When the row is being deleted outright, the
 * cascade removes the ciphertext automatically and this call is not needed.
 */
export async function clearCredentialsForAccount(
  admin: Admin,
  accountId: string,
  companyId: string,
): Promise<void> {
  const { error } = await admin
    .from("mail_accounts")
    .update({
      credentials_ciphertext: null,
      credentials_key_version: null,
      credentials_updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("company_id", companyId);
  if (error) {
    console.error("[mail-credentials] clear failed", { code: error.code });
    throw new MailCredentialsPersistError();
  }
}
