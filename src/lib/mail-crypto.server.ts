// Server-only. AES-256-GCM encryption for mail account credentials.
//
// Contract:
//   * Master key is stored in Supabase Vault under
//     `mail_credentials_master_key_v<version>` and fetched via the
//     `public.get_mail_credentials_master_key(version)` RPC (service_role only).
//   * Never accepts a master key from the caller; never returns it to the
//     caller; never logs it or ciphertext or plaintext.
//   * Storage format is a self-describing opaque string, versioned:
//        v<key_version>:<base64 nonce>:<base64 auth_tag>:<base64 ciphertext>
//     enabling live rotation to v2 later without downtime (readers accept
//     any version whose key is in Vault; writers use the "current" version).
//   * Nonce is 12 random bytes per encryption (GCM standard).
//   * Auth tag is 16 bytes (GCM standard).
//
// This file MUST NOT be imported from the client bundle. The `.server.ts`
// suffix triggers the project's import-guard.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Current key version used for new encryptions. Rotation bumps this. */
export const CURRENT_MAIL_KEY_VERSION = 1;

const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard
const TAG_BYTES = 16; // GCM standard

/**
 * Per-process cache of master keys by version.
 * Keys are loaded lazily on first use and never expire during the process
 * lifetime — Vault is the authoritative source, we simply avoid an RPC per
 * encrypt/decrypt call. The cache holds raw Buffer key material; the
 * process is a trusted server context.
 */
const keyCache = new Map<number, Buffer>();

export class MailCryptoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MailCryptoError";
  }
}

export class MailCryptoKeyMissingError extends MailCryptoError {
  constructor(version: number) {
    super("MAIL_CRYPTO_KEY_MISSING", `master key version ${version} not available`);
  }
}

export class MailCryptoFormatError extends MailCryptoError {
  constructor(reason: string) {
    // Do NOT include ciphertext or key material in the message.
    super("MAIL_CRYPTO_FORMAT_INVALID", `ciphertext format invalid: ${reason}`);
  }
}

export class MailCryptoAuthError extends MailCryptoError {
  constructor() {
    super("MAIL_CRYPTO_AUTH_FAIL", "authentication tag verification failed");
  }
}

type AdminLike = Pick<SupabaseClient, "rpc">;

/**
 * Load the master key for a given version from Vault via the RPC.
 * Cached per-process after first successful load.
 *
 * @internal exported for tests only.
 */
export async function loadMasterKey(admin: AdminLike, version: number): Promise<Buffer> {
  const cached = keyCache.get(version);
  if (cached) return cached;
  const { data, error } = await admin.rpc("get_mail_credentials_master_key", {
    p_version: version,
  });
  if (error) {
    // Do not leak the RPC error text (may include role names). Log server-side only.
    console.error("[mail-crypto] loadMasterKey rpc error", { version, code: error.code });
    throw new MailCryptoKeyMissingError(version);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new MailCryptoKeyMissingError(version);
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(data, "base64");
  } catch {
    throw new MailCryptoKeyMissingError(version);
  }
  if (raw.length !== KEY_BYTES) {
    throw new MailCryptoKeyMissingError(version);
  }
  keyCache.set(version, raw);
  return raw;
}

/** Test-only: reset the in-process key cache. */
export function __resetKeyCacheForTests(): void {
  keyCache.clear();
}

/** Test-only: seed a key without hitting Vault. */
export function __seedKeyForTests(version: number, key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error("test key must be 32 bytes");
  keyCache.set(version, Buffer.from(key));
}

/**
 * Encrypt a UTF-8 plaintext using the CURRENT key version.
 * Returns a self-describing opaque string safe to store in a text column.
 */
export async function encryptCredential(
  admin: AdminLike,
  plaintext: string,
): Promise<{ ciphertext: string; keyVersion: number }> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new MailCryptoError("MAIL_CRYPTO_EMPTY_PLAINTEXT", "plaintext must be non-empty");
  }
  const version = CURRENT_MAIL_KEY_VERSION;
  const key = await loadMasterKey(admin, version);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encoded = `v${version}:${nonce.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  return { ciphertext: encoded, keyVersion: version };
}

interface ParsedCiphertext {
  version: number;
  nonce: Buffer;
  tag: Buffer;
  ct: Buffer;
}

function parseCiphertext(stored: string): ParsedCiphertext {
  if (typeof stored !== "string") throw new MailCryptoFormatError("not a string");
  const parts = stored.split(":");
  if (parts.length !== 4) throw new MailCryptoFormatError("expected 4 parts");
  const [vRaw, nRaw, tRaw, cRaw] = parts;
  if (!vRaw.startsWith("v")) throw new MailCryptoFormatError("missing version prefix");
  const version = Number(vRaw.slice(1));
  if (!Number.isInteger(version) || version < 1 || version > 999) {
    throw new MailCryptoFormatError("bad version");
  }
  let nonce: Buffer, tag: Buffer, ct: Buffer;
  try {
    nonce = Buffer.from(nRaw, "base64");
    tag = Buffer.from(tRaw, "base64");
    ct = Buffer.from(cRaw, "base64");
  } catch {
    throw new MailCryptoFormatError("base64 decode failed");
  }
  if (nonce.length !== NONCE_BYTES) throw new MailCryptoFormatError("bad nonce length");
  if (tag.length !== TAG_BYTES) throw new MailCryptoFormatError("bad tag length");
  if (ct.length === 0) throw new MailCryptoFormatError("empty ciphertext");
  return { version, nonce, tag, ct };
}

/**
 * Decrypt a stored ciphertext. Throws MailCryptoAuthError if the auth tag
 * fails, MailCryptoFormatError if the string is malformed, or
 * MailCryptoKeyMissingError if the referenced key version is not available.
 *
 * The plaintext is a UTF-8 string. Callers should treat it as a live secret
 * and never log or return it beyond the immediate trusted use site (IMAP/SMTP
 * connection, or a re-encryption during rotation).
 */
export async function decryptCredential(admin: AdminLike, stored: string): Promise<string> {
  const parsed = parseCiphertext(stored);
  const key = await loadMasterKey(admin, parsed.version);
  const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce);
  decipher.setAuthTag(parsed.tag);
  try {
    const pt = Buffer.concat([decipher.update(parsed.ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // GCM final() throws on tag mismatch. Do not surface the raw error text.
    throw new MailCryptoAuthError();
  }
}

/**
 * Quick constant-time comparison helper used by tests to verify round-trips
 * without exposing plaintexts through toEqual diffs on failure.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
