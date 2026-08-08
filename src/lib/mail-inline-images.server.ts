import type { CacheLookup } from "@/lib/mail-body-cache.server";
import type { MailMessage } from "@/lib/mail-types";

export type InlinePart = NonNullable<MailMessage["inlineParts"]>[number];
export type InlineImage = NonNullable<MailMessage["inlineImages"]>[number];

export interface InlineBatchDependencies {
  lookup: () => Promise<CacheLookup>;
  fetchBatch: (parts: InlinePart[]) => Promise<{ images: InlineImage[]; failedCids: string[] }>;
  store: (uidValidity: string, images: InlineImage[]) => Promise<unknown>;
}

export interface InlineBatchResolution {
  images: InlineImage[];
  failedCids: string[];
  source: "cache" | "bridge" | "none";
}

/** Cache-first CID resolver. It calls fetchBatch at most once per invocation. */
export async function resolveInlineImageBatch(
  requestedParts: InlinePart[],
  deps: InlineBatchDependencies,
): Promise<InlineBatchResolution> {
  let cached = await deps.lookup().catch(() => null);
  const cachedImages = cached?.hit ? cached.body.inlineImages : [];
  const byCid = new Map(cachedImages.map((image) => [image.cid.toLowerCase(), image]));
  const pending = requestedParts.filter((part) => !byCid.has(part.cid.toLowerCase()));

  if (!pending.length) {
    return {
      images: cachedImages,
      failedCids: [],
      source: cached?.hit ? "cache" : "none",
    };
  }

  const fetched = await deps.fetchBatch(pending);
  for (const image of fetched.images) byCid.set(image.cid.toLowerCase(), image);
  const images = [...byCid.values()];

  // The body write is intentionally non-blocking on message-open. Re-check
  // after IMAP so a write that raced the first lookup can now receive images.
  if (!cached?.hit) cached = await deps.lookup().catch(() => null);
  if (cached?.hit) await deps.store(cached.body.uidValidity, images).catch(() => undefined);

  return { images, failedCids: fetched.failedCids, source: "bridge" };
}

const inFlight = new Map<string, Promise<InlineBatchResolution>>();

/** Server-process deduplication scoped by tenant/account/message identity. */
export function resolveInlineImageBatchSingleFlight(
  messageKey: string,
  worker: () => Promise<InlineBatchResolution>,
): Promise<InlineBatchResolution> {
  const existing = inFlight.get(messageKey);
  if (existing) return existing;
  const promise = worker().finally(() => inFlight.delete(messageKey));
  inFlight.set(messageKey, promise);
  return promise;
}
