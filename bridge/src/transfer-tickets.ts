import crypto from "node:crypto";
import { z } from "zod";
import type { MailAccount } from "./types.js";

const VERSION = 1;
const INFO = Buffer.from("mailmaestro-transfer-ticket-v1", "utf8");
const TicketEnvelopeSchema = z.object({
  v: z.literal(VERSION),
  purpose: z.string().min(1).max(64),
  exp: z.number().int().positive(),
  nonce: z.string().uuid(),
  account: z.string().length(64),
  data: z.record(z.unknown()),
});

export type TransferTicket = z.infer<typeof TicketEnvelopeSchema>;

function key(secret: string): Buffer {
  if (!secret) throw new Error("TRANSFER_TICKETS_NOT_CONFIGURED");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), INFO, 32));
}

function b64url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeB64url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (!value || b64url(decoded) !== value) throw new Error("INVALID_TICKET");
  return decoded;
}

export function accountBinding(account: Pick<MailAccount, "email_address" | "imap_host">): string {
  return crypto
    .createHash("sha256")
    .update(
      `${account.imap_host.trim().toLowerCase()}\0${account.email_address.trim().toLowerCase()}`,
    )
    .digest("hex");
}

export function sealTransferTicket(
  secret: string,
  input: Omit<TransferTicket, "v" | "nonce">,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(secret), iv);
  const plaintext = Buffer.from(
    JSON.stringify({ ...input, v: VERSION, nonce: crypto.randomUUID() }),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${b64url(iv)}.${b64url(ciphertext)}.${b64url(cipher.getAuthTag())}`;
}

export function openTransferTicket(
  secret: string,
  token: string,
  expected: { purpose: string; account?: string; now?: number },
): TransferTicket {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("INVALID_TICKET");
  try {
    const iv = decodeB64url(parts[0]);
    const ciphertext = decodeB64url(parts[1]);
    const tag = decodeB64url(parts[2]);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 16 * 1024) {
      throw new Error("INVALID_TICKET");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(secret), iv);
    decipher.setAuthTag(tag);
    const parsed = TicketEnvelopeSchema.parse(
      JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")),
    );
    if (parsed.purpose !== expected.purpose) throw new Error("WRONG_TICKET_PURPOSE");
    if (parsed.exp <= (expected.now ?? Date.now())) throw new Error("EXPIRED_TICKET");
    if (expected.account && parsed.account !== expected.account) {
      throw new Error("TICKET_ACCOUNT_MISMATCH");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && /^((WRONG|EXPIRED|TICKET)_|INVALID_TICKET)/.test(error.message)) {
      throw error;
    }
    throw new Error("INVALID_TICKET");
  }
}
