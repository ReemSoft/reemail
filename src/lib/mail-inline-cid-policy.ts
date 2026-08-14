import type { MailMessage } from "@/lib/mail-types";

export type InlineCidPart = NonNullable<MailMessage["inlineParts"]>[number];

export const INLINE_CID_FAST_MAX_BYTES = 256 * 1024;
export const INLINE_CID_FAST_TOTAL_BYTES = 1024 * 1024;
export const INLINE_CID_MAX_COUNT = 20;
export const INLINE_CID_STREAM_MAX_BYTES = 5 * 1024 * 1024;

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

export interface InlineCidBytesMapping {
  cid: string;
  mimeType: string;
  bytes: ArrayBuffer;
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
