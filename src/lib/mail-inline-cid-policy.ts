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
    if (embedded.has(cid) || seen.has(cid)) continue;
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

export interface InlineCidBlobMapping {
  cid: string;
  blobUrl: string;
}

export interface StreamInlineCidDependencies {
  signal: AbortSignal;
  fetchPart: (part: InlineCidPart, signal: AbortSignal) => Promise<Response>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  onMapping: (mapping: InlineCidBlobMapping) => void;
}

/** Low-priority, strictly sequential streaming. A failed CID never fails the message. */
export async function streamInlineCidPartsSequential(
  parts: readonly InlineCidPart[],
  dependencies: StreamInlineCidDependencies,
): Promise<void> {
  for (const part of parts) {
    if (dependencies.signal.aborted) return;
    try {
      const response = await dependencies.fetchPart(part, dependencies.signal);
      if (!response.ok || dependencies.signal.aborted) continue;
      const responseMime = response.headers.get("Content-Type") ?? "";
      if (!areInlineImageMimesCompatible(part.mimeType, responseMime)) continue;
      const contentLength = response.headers.get("Content-Length");
      if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isFinite(declared) || declared < 0 || declared > INLINE_CID_STREAM_MAX_BYTES)
          continue;
      }
      const blob = await response.blob();
      if (dependencies.signal.aborted) return;
      if (
        blob.size === 0 ||
        blob.size > INLINE_CID_STREAM_MAX_BYTES ||
        (blob.type && !areInlineImageMimesCompatible(part.mimeType, blob.type))
      )
        continue;
      const blobUrl = dependencies.createObjectURL(blob);
      if (dependencies.signal.aborted) {
        dependencies.revokeObjectURL(blobUrl);
        return;
      }
      try {
        dependencies.onMapping({ cid: part.cid, blobUrl });
      } catch {
        dependencies.revokeObjectURL(blobUrl);
      }
    } catch {
      if (dependencies.signal.aborted) return;
    }
  }
}
