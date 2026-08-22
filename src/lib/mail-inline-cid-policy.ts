import type { MailMessage } from "@/lib/mail-types";

export type InlineCidPart = NonNullable<MailMessage["inlineParts"]>[number];

export const INLINE_CID_FAST_MAX_BYTES = 256 * 1024;
export const INLINE_CID_FAST_TOTAL_BYTES = 1024 * 1024;
export const INLINE_CID_MAX_COUNT = 20;
export const INLINE_CID_METADATA_MAX_COUNT = 50;
export const INLINE_CID_STREAM_MAX_BYTES = 25 * 1024 * 1024;
export const INLINE_CID_VISIBLE_BATCH_MAX_COUNT = 4;
export const INLINE_CID_VISIBLE_BATCH_MAX_BYTES = 64 * 1024;

const INLINE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export interface InlineCidPartition {
  smallBatchParts: InlineCidPart[];
  largeStreamParts: InlineCidPart[];
  overflowStreamParts: InlineCidPart[];
  oversizedUnsafeParts: InlineCidPart[];
}

/**
 * Return only cid: image references present in one rendered HTML fragment.
 * This is intentionally pure/string-only so deciding image scope adds zero DOM
 * work and zero network work to message opening. The iframe calls it only for
 * the fragment it actually renders (latest turn, or an expanded history turn).
 */
export function extractReferencedInlineCids(
  html: string,
  maxCount = INLINE_CID_METADATA_MAX_COUNT,
): string[] {
  if (!html || maxCount <= 0 || !/<img\b/i.test(html) || !/\bcid:/i.test(html)) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  const imgRe = /<img\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = imgRe.exec(html)) !== null && result.length < maxCount) {
    const tag = tagMatch[0];
    const srcMatch = tag.match(
      /\bsrc\s*=\s*(?:"\s*cid:([^"]*)"|'\s*cid:([^']*)'|cid:([^\s>]+))/i,
    );
    let cid = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    if (!cid) continue;

    cid = cid
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
    try {
      cid = decodeURIComponent(cid);
    } catch {
      // Literal '%' in a legal Content-ID is kept unchanged.
    }
    cid = cid.replace(/^<|>$/g, "").trim().toLowerCase();
    if (!cid || cid.length > 998 || seen.has(cid)) continue;
    seen.add(cid);
    result.push(cid);
  }

  return result;
}

/** Keep each post-paint Bridge request inside both count and decoded-byte limits. */
export function chunkInlineCidParts(
  parts: readonly InlineCidPart[],
  maxCount = 5,
  maxBytes = 25 * 1024 * 1024,
): InlineCidPart[][] {
  const batches: InlineCidPart[][] = [];
  let current: InlineCidPart[] = [];
  let currentBytes = 0;
  for (const part of parts) {
    if (current.length && (current.length >= maxCount || currentBytes + part.size > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    if (part.size > maxBytes) continue;
    current.push(part);
    currentBytes += part.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function normalizeInlineImageMime(value: string): string {
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

export function isAllowedInlineImageMime(value: unknown): value is string {
  return (
    typeof value === "string" && INLINE_IMAGE_MIMES.has(value.split(";", 1)[0].trim().toLowerCase())
  );
}

export function areInlineImageMimesCompatible(expected: string, actual: string): boolean {
  return (
    isAllowedInlineImageMime(expected) &&
    isAllowedInlineImageMime(actual) &&
    normalizeInlineImageMime(expected) === normalizeInlineImageMime(actual)
  );
}

function isValidPartMetadata(part: InlineCidPart): boolean {
  return (
    typeof part.cid === "string" &&
    part.cid.length > 0 &&
    part.cid.length <= 998 &&
    /^\d+(?:\.\d+)*$/.test(part.part) &&
    isAllowedInlineImageMime(part.mimeType) &&
    Number.isInteger(part.size) &&
    part.size >= 0
  );
}

/** One policy for viewer, prefetch and the protected small-batch boundary. */
export function partitionInlineCidParts(
  parts: readonly InlineCidPart[],
  embeddedCids: Iterable<string> = [],
): InlineCidPartition {
  const embedded = new Set(Array.from(embeddedCids, (cid) => cid.toLowerCase()));
  const cidOwners = new Map<string, string>();
  const ambiguousCids = new Set<string>();
  for (const part of parts) {
    const cid = typeof part.cid === "string" ? part.cid.toLowerCase() : "";
    if (!cid) continue;
    const mime = typeof part.mimeType === "string" ? normalizeInlineImageMime(part.mimeType) : "";
    const owner = `${String(part.part)}\u0000${mime}\u0000${String(part.size)}`;
    const existing = cidOwners.get(cid);
    if (existing !== undefined && existing !== owner) ambiguousCids.add(cid);
    else cidOwners.set(cid, owner);
  }
  const seen = new Set<string>();
  const result: InlineCidPartition = {
    smallBatchParts: [],
    largeStreamParts: [],
    overflowStreamParts: [],
    oversizedUnsafeParts: [],
  };
  let smallBytes = 0;

  for (const part of parts) {
    const cid = typeof part.cid === "string" ? part.cid.toLowerCase() : "";
    if (embedded.has(cid) || ambiguousCids.has(cid) || seen.has(cid)) continue;
    seen.add(cid);
    if (!isValidPartMetadata(part) || part.size > INLINE_CID_STREAM_MAX_BYTES) {
      result.oversizedUnsafeParts.push(part);
      continue;
    }
    if (part.size > INLINE_CID_FAST_MAX_BYTES) {
      result.largeStreamParts.push(part);
      continue;
    }
    if (
      result.smallBatchParts.length < INLINE_CID_MAX_COUNT &&
      smallBytes + part.size <= INLINE_CID_FAST_TOTAL_BYTES
    ) {
      result.smallBatchParts.push(part);
      smallBytes += part.size;
    } else {
      result.overflowStreamParts.push(part);
    }
  }
  return result;
}

/**
 * Select the next latency-first visible batch. Known tiny parts are ordered
 * ahead of larger parts and an atomic response is capped at 64 KiB whenever
 * possible, so a signature/logo is not held behind the rest of the 1 MiB
 * small-image window. Unknown (zero) sizes remain eligible but sort last.
 */
export function nextVisibleInlineCidBatch(parts: readonly InlineCidPart[]): InlineCidPart[] {
  const ordered = parts
    .map((part, index) => ({ part, index }))
    .sort((a, b) => {
      const aSize = a.part.size > 0 ? a.part.size : Number.MAX_SAFE_INTEGER;
      const bSize = b.part.size > 0 ? b.part.size : Number.MAX_SAFE_INTEGER;
      return aSize - bSize || a.index - b.index;
    })
    .map(({ part }) => part);
  if (!ordered.length) return [];

  const first = ordered[0];
  const maxBytes = Math.max(INLINE_CID_VISIBLE_BATCH_MAX_BYTES, first.size);
  const batch: InlineCidPart[] = [];
  let bytes = 0;
  for (const part of ordered) {
    if (
      batch.length >= INLINE_CID_VISIBLE_BATCH_MAX_COUNT ||
      (batch.length > 0 && bytes + part.size > maxBytes)
    ) {
      break;
    }
    batch.push(part);
    bytes += part.size;
  }
  return batch;
}

export interface InlineCidBytesMapping {
  cid: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

const LARGE_CID_SESSION_MAX_BYTES = 20 * 1024 * 1024;
const largeCidSessionCache = new Map<
  string,
  { cid: string; mimeType: string; bytes: Uint8Array; lastUsed: number }
>();
let largeCidSessionBytes = 0;

function largeCidCacheKey(messageKey: string, part: InlineCidPart): string {
  return `${messageKey}|${part.part}|${part.cid.toLowerCase()}`;
}

export function readLargeInlineCidSessionCache(
  messageKey: string,
  parts: readonly InlineCidPart[],
): { hits: InlineCidBytesMapping[]; misses: InlineCidPart[] } {
  const hits: InlineCidBytesMapping[] = [];
  const misses: InlineCidPart[] = [];
  for (const part of parts) {
    const entry = largeCidSessionCache.get(largeCidCacheKey(messageKey, part));
    if (!entry) {
      misses.push(part);
      continue;
    }
    entry.lastUsed = Date.now();
    hits.push({
      cid: entry.cid,
      mimeType: entry.mimeType,
      bytes: entry.bytes.slice().buffer,
    });
  }
  return { hits, misses };
}

export function storeLargeInlineCidSessionCache(
  messageKey: string,
  parts: readonly InlineCidPart[],
  images: readonly InlineCidBytesMapping[],
): void {
  const byCid = new Map(parts.map((part) => [part.cid.toLowerCase(), part]));
  for (const image of images) {
    const part = byCid.get(image.cid.toLowerCase());
    if (!part || image.bytes.byteLength > INLINE_CID_STREAM_MAX_BYTES) continue;
    const key = largeCidCacheKey(messageKey, part);
    const previous = largeCidSessionCache.get(key);
    if (previous) largeCidSessionBytes -= previous.bytes.byteLength;
    const bytes = new Uint8Array(image.bytes.slice(0));
    largeCidSessionCache.set(key, {
      cid: image.cid,
      mimeType: image.mimeType,
      bytes,
      lastUsed: Date.now(),
    });
    largeCidSessionBytes += bytes.byteLength;
  }
  while (largeCidSessionBytes > LARGE_CID_SESSION_MAX_BYTES && largeCidSessionCache.size) {
    const oldest = [...largeCidSessionCache.entries()].reduce((a, b) =>
      a[1].lastUsed <= b[1].lastUsed ? a : b,
    );
    largeCidSessionCache.delete(oldest[0]);
    largeCidSessionBytes -= oldest[1].bytes.byteLength;
  }
}

export function clearLargeInlineCidSessionCache(): void {
  largeCidSessionCache.clear();
  largeCidSessionBytes = 0;
}

export interface StreamInlineCidDependencies {
  signal: AbortSignal;
  fetchPart: (part: InlineCidPart, signal: AbortSignal) => Promise<Response>;
  onMapping: (mapping: InlineCidBytesMapping) => void;
  onTiming?: (
    event:
      | "large-cid-request-start"
      | "large-cid-response-ready"
      | "large-cid-complete"
      | "large-cid-bytes",
    fields: { elapsedMs: number; bytes: number },
  ) => void;
}

export interface BatchInlineCidDependencies {
  signal: AbortSignal;
  fetchBatch: (parts: readonly InlineCidPart[], signal: AbortSignal) => Promise<Response>;
}

export class InlineMediaBusyResponseError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("IMAP_BUSY");
    this.name = "InlineMediaBusyResponseError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isInlineMediaBusyResponseError(
  error: unknown,
): error is InlineMediaBusyResponseError {
  return error instanceof InlineMediaBusyResponseError;
}

/** Parse one authenticated multipart response into one atomic render mapping. */
export async function fetchInlineCidPartsBatch(
  parts: readonly InlineCidPart[],
  dependencies: BatchInlineCidDependencies,
): Promise<InlineCidBytesMapping[]> {
  if (!parts.length || dependencies.signal.aborted) return [];
  const response = await dependencies.fetchBatch(parts, dependencies.signal);
  if (response.status === 503) {
    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    throw new InlineMediaBusyResponseError(
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(2_000, retryAfterSeconds * 1_000)
        : 250,
    );
  }
  if (!response.ok || dependencies.signal.aborted) return [];
  const form = await response.formData();
  const rawMetadata = form.get("metadata");
  if (typeof rawMetadata !== "string") return [];
  let metadata: unknown;
  try {
    metadata = JSON.parse(rawMetadata);
  } catch {
    return [];
  }
  const rows = (metadata as { images?: unknown })?.images;
  if (!Array.isArray(rows) || rows.length > 20) return [];
  const requested = new Map(parts.map((part) => [part.cid.toLowerCase(), part]));
  let totalBytes = 0;
  const mappings: InlineCidBytesMapping[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const cid = typeof value.cid === "string" ? value.cid : "";
    const expected = requested.get(cid.toLowerCase());
    const index = Number(value.index);
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : "";
    const size = Number(value.size);
    const file = Number.isInteger(index) ? form.get(`image-${index}`) : null;
    if (
      !expected ||
      value.part !== expected.part ||
      !areInlineImageMimesCompatible(expected.mimeType, mimeType) ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > INLINE_CID_STREAM_MAX_BYTES ||
      !(file instanceof Blob) ||
      file.size !== size ||
      totalBytes + size > 25 * 1024 * 1024
    ) {
      continue;
    }
    const bytes = await file.arrayBuffer();
    if (dependencies.signal.aborted) return [];
    totalBytes += bytes.byteLength;
    mappings.push({ cid, mimeType, bytes });
  }
  return mappings;
}

/** Low-priority, strictly sequential streaming. A failed CID never fails the message. */
export async function streamInlineCidPartsSequential(
  parts: readonly InlineCidPart[],
  dependencies: StreamInlineCidDependencies,
): Promise<void> {
  for (const part of parts) {
    if (dependencies.signal.aborted) return;
    const startedAt = performance.now();
    try {
      dependencies.onTiming?.("large-cid-request-start", { elapsedMs: 0, bytes: 0 });
      const response = await dependencies.fetchPart(part, dependencies.signal);
      dependencies.onTiming?.("large-cid-response-ready", {
        elapsedMs: Math.round(performance.now() - startedAt),
        bytes: 0,
      });
      if (!response.ok || dependencies.signal.aborted) continue;
      const responseMime = response.headers.get("Content-Type") ?? "";
      if (!areInlineImageMimesCompatible(part.mimeType, responseMime)) continue;
      const contentLength = response.headers.get("Content-Length");
      if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isFinite(declared) || declared < 0 || declared > INLINE_CID_STREAM_MAX_BYTES)
          continue;
      }
      const bytes = await response.arrayBuffer();
      if (dependencies.signal.aborted) return;
      if (bytes.byteLength === 0 || bytes.byteLength > INLINE_CID_STREAM_MAX_BYTES) continue;
      dependencies.onMapping({ cid: part.cid, mimeType: responseMime, bytes });
      dependencies.onTiming?.("large-cid-complete", {
        elapsedMs: Math.round(performance.now() - startedAt),
        bytes: bytes.byteLength,
      });
      dependencies.onTiming?.("large-cid-bytes", { elapsedMs: 0, bytes: bytes.byteLength });
    } catch {
      if (dependencies.signal.aborted) return;
    }
  }
}
