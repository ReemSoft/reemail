/**
 * Disk-backed multer storage for outbound attachments.
 *
 * Rationale: multer.memoryStorage() holds every uploaded byte in RSS for the
 * lifetime of the send. Ten users emailing three 25MB files at once would
 * pin ~750MB of heap on a tiny bridge VM. Streaming to a scoped temp dir on
 * disk keeps RSS flat regardless of upload burst.
 *
 * Hardening:
 *   * Files live in a dedicated dir (default /tmp/mailmaestro-uploads).
 *   * The dir is created with mode 0o700 (owner-only).
 *   * Every file gets a cryptographically-random name; the client's
 *     `originalname` is NEVER used on disk, so "../../etc/passwd" style
 *     names cannot traverse or clobber anything.
 *   * `cleanupFiles` is idempotent and swallows ENOENT — safe to call from
 *     the happy path, error handler, and `req.on("close")` without
 *     double-delete crashes.
 *   * `startupCleanup` sweeps stale leftovers (>1h) once at boot so a
 *     crashed process doesn't leak forever.
 */
import { promises as fs, constants as fsConstants, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

export const UPLOAD_DIR = process.env.MAIL_UPLOAD_DIR || "/tmp/mailmaestro-uploads";

// Ensure the dir exists synchronously at import time so the diskStorage
// engine always has a valid target before Express binds routes.
try {
  mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
} catch (err: unknown) {
  // If the directory already exists mkdirSync with recursive:true is a
  // no-op; anything else is a genuine boot failure we should surface.
  const e = err as NodeJS.ErrnoException;
  if (e?.code !== "EEXIST") {
    console.error("[bridge] failed to create upload dir:", UPLOAD_DIR, e?.message);
  }
}

/** Random on-disk filename. Never uses client-supplied names. */
export function randomStoredName(): string {
  return `up_${Date.now().toString(36)}_${crypto.randomUUID()}.bin`;
}

/** multer storage engine → writes chunks straight to UPLOAD_DIR. */
export const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, randomStoredName()),
});

export interface StoredUpload {
  /** Absolute path on disk — safe to hand to nodemailer as attachment.path */
  path: string;
  /** Bytes as reported by multer. */
  size: number;
}

/** Delete every listed file, tolerating already-gone paths. Idempotent. */
export async function cleanupFiles(files: Array<{ path?: string } | undefined | null>): Promise<void> {
  if (!files?.length) return;
  await Promise.all(
    files.map(async (f) => {
      const p = f?.path;
      if (!p) return;
      // Refuse to delete anything outside the sanctioned upload dir even
      // if something upstream tampered with the multer file object.
      const abs = path.resolve(p);
      const root = path.resolve(UPLOAD_DIR);
      if (!abs.startsWith(root + path.sep) && abs !== root) return;
      try {
        await fs.unlink(abs);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code !== "ENOENT") {
          console.error("[bridge] cleanup unlink failed:", e?.code || e?.message);
        }
      }
    }),
  );
}

/** Sweep stale files (>maxAgeMs) from UPLOAD_DIR. Best-effort, no throw. */
export async function startupCleanup(maxAgeMs: number = 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  try {
    await fs.access(UPLOAD_DIR, fsConstants.F_OK);
  } catch {
    return 0;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(UPLOAD_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (name) => {
      const abs = path.join(UPLOAD_DIR, name);
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) return;
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(abs).catch(() => {});
          removed++;
        }
      } catch {
        /* skip — file vanished between readdir and stat */
      }
    }),
  );
  return removed;
}
