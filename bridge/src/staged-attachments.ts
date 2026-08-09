import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { openTransferTicket, sealTransferTicket } from "./transfer-tickets.js";

export const STAGE_DIR =
  process.env.MAIL_STAGE_DIR ||
  (process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".cache", "mailmaestro-stage")
    : "/tmp/mailmaestro-stage");
export const STAGE_TTL_MS = Number(process.env.MAIL_STAGE_TTL_MS || 24 * 60 * 60_000);
export const STAGE_GLOBAL_BYTES = Number(process.env.MAIL_STAGE_GLOBAL_BYTES || 2 * 1024 ** 3);
export const STAGE_ACCOUNT_BYTES = Number(process.env.MAIL_STAGE_ACCOUNT_BYTES || 250 * 1024 ** 2);
export const STAGE_GLOBAL_FILES = Number(process.env.MAIL_STAGE_GLOBAL_FILES || 10_000);
export const STAGE_ACCOUNT_FILES = Number(process.env.MAIL_STAGE_ACCOUNT_FILES || 100);

export interface StagedAttachment {
  handle: string;
  filename: string;
  size: number;
  mimeType: string;
  kind: "attachment" | "inline-image";
  expiresAt: number;
}

export interface ResolvedStagedAttachment extends Omit<StagedAttachment, "handle" | "expiresAt"> {
  path: string;
}

const accountBytes = new Map<string, number>();
const accountFiles = new Map<string, number>();
let trackedGlobalBytes = 0;
let trackedGlobalFiles = 0;

async function ensureDir() {
  await mkdir(STAGE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STAGE_DIR, 0o700).catch(() => undefined);
}

function safePath(id: string): string {
  if (!/^[0-9a-f]{64}-[0-9a-f-]{36}$/i.test(id)) throw new Error("INVALID_STAGE_HANDLE");
  const resolved = path.resolve(STAGE_DIR, `${id}.bin`);
  const root = path.resolve(STAGE_DIR);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("INVALID_STAGE_HANDLE");
  return resolved;
}

function readStagedTicket(
  secret: string,
  handle: string,
  account: string,
  now: number,
): {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  kind: "attachment" | "inline-image";
} {
  const ticket = openTransferTicket(secret, handle, {
    purpose: "staged-attachment",
    account,
    now,
  });
  const data = ticket.data as Record<string, unknown>;
  if (
    typeof data.id !== "string" ||
    typeof data.filename !== "string" ||
    typeof data.mimeType !== "string" ||
    typeof data.size !== "number" ||
    (data.kind !== "attachment" && data.kind !== "inline-image")
  ) {
    throw new Error("INVALID_STAGE_HANDLE");
  }
  return {
    id: data.id,
    filename: data.filename,
    size: data.size,
    mimeType: data.mimeType,
    kind: data.kind,
  };
}

function decrementTrackedUsage(account: string, bytes: number) {
  trackedGlobalBytes = Math.max(0, trackedGlobalBytes - bytes);
  trackedGlobalFiles = Math.max(0, trackedGlobalFiles - 1);
  const nextAccountBytes = Math.max(0, (accountBytes.get(account) ?? 0) - bytes);
  const nextAccountFiles = Math.max(0, (accountFiles.get(account) ?? 0) - 1);
  if (nextAccountBytes === 0) accountBytes.delete(account);
  else accountBytes.set(account, nextAccountBytes);
  if (nextAccountFiles === 0) accountFiles.delete(account);
  else accountFiles.set(account, nextAccountFiles);
}

export async function stageAttachmentStream(input: {
  secret: string;
  account: string;
  filename: string;
  mimeType: string;
  kind: "attachment" | "inline-image";
  declaredSize: number;
  maxSize?: number;
  exactSize?: boolean;
  stream: Readable;
  now?: number;
}): Promise<StagedAttachment> {
  await ensureDir();
  const currentAccount = accountBytes.get(input.account) ?? 0;
  const currentAccountFiles = accountFiles.get(input.account) ?? 0;
  const reservationSize =
    input.exactSize === false ? (input.maxSize ?? input.declaredSize) : input.declaredSize;
  if (
    trackedGlobalBytes + reservationSize > STAGE_GLOBAL_BYTES ||
    currentAccount + reservationSize > STAGE_ACCOUNT_BYTES ||
    trackedGlobalFiles >= STAGE_GLOBAL_FILES ||
    currentAccountFiles >= STAGE_ACCOUNT_FILES
  ) {
    throw new Error("STAGE_QUOTA_EXCEEDED");
  }
  const id = `${input.account}-${crypto.randomUUID()}`;
  const target = safePath(id);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      const maximum = input.maxSize ?? input.declaredSize;
      callback(bytes > maximum ? new Error("UPLOAD_TOO_LARGE") : null, chunk);
    },
  });
  try {
    await pipeline(input.stream, limiter, createWriteStream(target, { flags: "wx", mode: 0o600 }));
    if (input.exactSize !== false && bytes !== input.declaredSize) {
      throw new Error("UPLOAD_SIZE_MISMATCH");
    }
    trackedGlobalBytes += bytes;
    trackedGlobalFiles += 1;
    accountBytes.set(input.account, currentAccount + bytes);
    accountFiles.set(input.account, currentAccountFiles + 1);
    const expiresAt = (input.now ?? Date.now()) + STAGE_TTL_MS;
    const handle = sealTransferTicket(input.secret, {
      purpose: "staged-attachment",
      account: input.account,
      exp: expiresAt,
      data: {
        id,
        filename: input.filename,
        size: bytes,
        mimeType: input.mimeType,
        kind: input.kind,
      },
    });
    return {
      handle,
      filename: input.filename,
      size: bytes,
      mimeType: input.mimeType,
      kind: input.kind,
      expiresAt,
    };
  } catch (error) {
    input.stream.destroy();
    await unlink(target).catch(() => undefined);
    throw error;
  }
}

export async function resolveStagedAttachment(
  secret: string,
  handle: string,
  account: string,
  now = Date.now(),
): Promise<ResolvedStagedAttachment> {
  const data = readStagedTicket(secret, handle, account, now);
  const filePath = safePath(data.id);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error("STAGED_FILE_MISSING");
  if (info.size !== data.size) throw new Error("STAGED_FILE_SIZE_MISMATCH");
  return {
    path: filePath,
    filename: data.filename,
    size: data.size,
    mimeType: data.mimeType,
    kind: data.kind,
  };
}

export async function releaseStagedAttachment(
  secret: string,
  handle: string,
  account: string,
  now = Date.now(),
): Promise<boolean> {
  const data = readStagedTicket(secret, handle, account, now);
  const filePath = safePath(data.id);
  try {
    await unlink(filePath);
    decrementTrackedUsage(account, data.size);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function releaseStagedAttachments(
  secret: string,
  handles: string[],
  account: string,
): Promise<number> {
  let released = 0;
  for (const handle of new Set(handles)) {
    if (await releaseStagedAttachment(secret, handle, account)) released += 1;
  }
  return released;
}

export async function cleanupSendStagedAttachments(input: {
  secret: string;
  account: string;
  clientHandles: string[];
  sourceHandles: string[];
  sendSucceeded: boolean;
}): Promise<void> {
  await releaseStagedAttachments(input.secret, input.sourceHandles, input.account);
  if (input.sendSucceeded) {
    await releaseStagedAttachments(input.secret, input.clientHandles, input.account);
  }
}

export async function cleanupStagedAttachments(
  maxAgeMs = STAGE_TTL_MS,
  now = Date.now(),
): Promise<number> {
  await ensureDir();
  let removed = 0;
  const freshByAccount = new Map<string, number>();
  const freshFilesByAccount = new Map<string, number>();
  let freshGlobal = 0;
  let freshGlobalFiles = 0;
  for (const name of await readdir(STAGE_DIR).catch(() => [] as string[])) {
    const match = name.match(/^([0-9a-f]{64})-[0-9a-f-]{36}\.bin$/i);
    if (!match) continue;
    const filePath = path.join(STAGE_DIR, name);
    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        removed += 1;
      } else {
        freshGlobal += info.size;
        freshGlobalFiles += 1;
        freshByAccount.set(match[1], (freshByAccount.get(match[1]) ?? 0) + info.size);
        freshFilesByAccount.set(match[1], (freshFilesByAccount.get(match[1]) ?? 0) + 1);
      }
    } catch {
      // Concurrent cleanup is harmless.
    }
  }
  accountBytes.clear();
  accountFiles.clear();
  for (const [account, bytes] of freshByAccount) accountBytes.set(account, bytes);
  for (const [account, files] of freshFilesByAccount) accountFiles.set(account, files);
  trackedGlobalBytes = freshGlobal;
  trackedGlobalFiles = freshGlobalFiles;
  return removed;
}

export function stagedAttachmentStats() {
  return {
    stagedBytes: trackedGlobalBytes,
    stagedFiles: trackedGlobalFiles,
    trackedAccounts: accountBytes.size,
  };
}

export function openStagedAttachment(pathname: string) {
  return createReadStream(pathname);
}
