import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { pipeline } from "node:stream/promises";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { SendMessagePayload } from "./smtp.js";
import { normalizeThreadingHeaders } from "./threading-headers.js";

export const MIME_SPOOL_DIR =
  process.env.MAIL_MIME_SPOOL_DIR ||
  (process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".cache", "mailmaestro-spool")
    : "/tmp/mailmaestro-spool");
export const MIME_SPOOL_MAX_AGE_MS = Number(process.env.MAIL_MIME_SPOOL_MAX_AGE_MS || 60 * 60_000);

/**
 * Hard ceiling for materialising a spool in memory (IMAP APPEND only).
 *
 * Derived from the existing send limit (SEND_MAX_TOTAL_BYTES, default 25 MiB)
 * plus 60% headroom for base64 + headers. It does NOT change any send limit —
 * it only bounds the transient Buffer used by the background Sent finalizer.
 */
export const SENT_APPEND_MAX_BYTES = Number(
  process.env.SENT_APPEND_MAX_BYTES ||
    Math.ceil(Number(process.env.SEND_MAX_TOTAL_BYTES || 25 * 1024 * 1024) * 1.6),
);

export class MimeSpoolTooLargeError extends Error {
  readonly code = "SENT_COPY_TOO_LARGE";
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super("MIME spool exceeds the in-memory APPEND limit");
    this.name = "MimeSpoolTooLargeError";
  }
}

export interface MimeSpool {
  path: string;
  messageId: string;
  size: number;
  openReadStream: () => Readable;
  cleanup: () => Promise<void>;
  /** Read the exact same on-disk bytes into a bounded Buffer (IMAP APPEND). */
  readBuffer?: (maxBytes?: number) => Promise<Buffer>;
}

/**
 * ImapFlow 1.5's `append()` contract is `string | Buffer` — passing a Readable
 * silently breaks (`content.length` / `content.indexOf` are undefined) and
 * surfaces as IMAP_UNKNOWN. Always append bytes read back from the spool so
 * every attempt is byte-identical to what SMTP streamed.
 */
export async function readMimeSpoolBuffer(
  spool: MimeSpool,
  maxBytes: number = SENT_APPEND_MAX_BYTES,
): Promise<Buffer> {
  if (spool.readBuffer) return spool.readBuffer(maxBytes);
  if (spool.size > maxBytes) throw new MimeSpoolTooLargeError(spool.size, maxBytes);
  const buffer = await readFile(spool.path);
  if (buffer.byteLength > maxBytes) throw new MimeSpoolTooLargeError(buffer.byteLength, maxBytes);
  return buffer;
}

export async function withMimeSpoolReadStream<T>(
  spool: MimeSpool,
  consume: (raw: Readable) => Promise<T>,
): Promise<T> {
  const raw = spool.openReadStream();
  let streamFailure: unknown;
  const streamSettled = finished(raw, { cleanup: true }).catch((error: unknown) => {
    streamFailure = error;
  });
  let consumerFailed = false;
  let consumerFailure: unknown;
  let result: T | undefined;
  try {
    result = await consume(raw);
  } catch (error) {
    consumerFailed = true;
    consumerFailure = error;
  } finally {
    if (!raw.destroyed) raw.destroy();
    await streamSettled;
  }
  if (consumerFailed) throw consumerFailure;
  if (streamFailure) throw streamFailure;
  return result as T;
}

function composerOptions(
  payload: SendMessagePayload,
  extraHeaders?: Record<string, string>,
): Record<string, unknown> {
  const threading = normalizeThreadingHeaders(payload.inReplyTo, payload.references);
  const address = (value: { name: string; email: string }) =>
    value.name ? `"${value.name}" <${value.email}>` : value.email;
  return {
    from: address(payload.from),
    to: payload.to.map(address).join(", "),
    ...(payload.cc?.length ? { cc: payload.cc.map(address).join(", ") } : {}),
    ...(payload.bcc?.length ? { bcc: payload.bcc.map(address).join(", ") } : {}),
    subject: payload.subject,
    ...threading,
    text: payload.bodyText || "",
    html: payload.bodyHtml || "",
    ...(payload.attachments?.length
      ? {
          attachments: payload.attachments.map((attachment) => ({
            filename: attachment.filename,
            ...(attachment.path ? { path: attachment.path } : { content: attachment.content }),
            contentType: attachment.contentType,
            cid: attachment.cid,
            contentDisposition: attachment.contentDisposition,
          })),
        }
      : {}),
    ...(extraHeaders && Object.keys(extraHeaders).length ? { headers: { ...extraHeaders } } : {}),
  };
}

export function compileMime(payload: SendMessagePayload, extraHeaders?: Record<string, string>) {
  return new MailComposer(composerOptions(payload, extraHeaders)).compile();
}

async function ensureSpoolDir(): Promise<void> {
  await mkdir(MIME_SPOOL_DIR, { recursive: true, mode: 0o700 });
  await chmod(MIME_SPOOL_DIR, 0o700).catch(() => undefined);
}

export async function createMimeSpool(
  payload: SendMessagePayload,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<MimeSpool> {
  await ensureSpoolDir();
  const spoolPath = path.join(MIME_SPOOL_DIR, `${crypto.randomUUID()}.eml`);
  const compiled = compileMime(payload, extraHeaders);
  const messageId = compiled.messageId();
  try {
    const source = compiled.createReadStream();
    const destination = createWriteStream(spoolPath, { flags: "wx", mode: 0o600 });
    if (signal) await pipeline(source, destination, { signal });
    else await pipeline(source, destination);
    const info = await stat(spoolPath);
    let cleaned = false;
    return {
      path: spoolPath,
      messageId,
      size: info.size,
      openReadStream: () => createReadStream(spoolPath),
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await unlink(spoolPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      },
    };
  } catch (error) {
    await unlink(spoolPath).catch(() => undefined);
    throw error;
  }
}

export async function cleanupStaleMimeSpools(
  maxAgeMs = MIME_SPOOL_MAX_AGE_MS,
  now = Date.now(),
): Promise<number> {
  await ensureSpoolDir();
  let removed = 0;
  for (const name of await readdir(MIME_SPOOL_DIR).catch(() => [] as string[])) {
    if (!/^[0-9a-f-]{36}\.eml$/i.test(name)) continue;
    const candidate = path.join(MIME_SPOOL_DIR, name);
    try {
      const info = await stat(candidate);
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
        await unlink(candidate);
        removed += 1;
      }
    } catch {
      // A concurrent request or cleanup may already have removed it.
    }
  }
  return removed;
}
