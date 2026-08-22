import type { CidImageMapping } from "@/lib/email-viewer-security";

export interface ResolvedCidImageState {
  key: string;
  images: CidImageMapping[];
}

/**
 * Merge decoded CID mappings without changing React state identity when the
 * effective mapping is unchanged. This prevents effects derived from the
 * resolved CID set from retriggering solely because a new equivalent object
 * was allocated.
 */
export function mergeResolvedCidImagesStable(
  current: ResolvedCidImageState,
  messageKey: string,
  incoming: readonly CidImageMapping[],
): ResolvedCidImageState {
  if (current.key !== messageKey || incoming.length === 0) return current;

  const byCid = new Map(
    current.images.map((image) => [image.cid.toLowerCase(), image] as const),
  );
  let changed = false;

  for (const image of incoming) {
    const cid = image.cid.toLowerCase();
    const existing = byCid.get(cid);

    if (
      existing &&
      existing.dataUri === image.dataUri &&
      existing.width === image.width &&
      existing.height === image.height
    ) {
      continue;
    }

    byCid.set(cid, image);
    changed = true;
  }

  return changed ? { key: messageKey, images: [...byCid.values()] } : current;
}
