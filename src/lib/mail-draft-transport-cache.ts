import type { DraftStorageLike } from "./mail-draft-lifecycle";

const PREFIX = "mailmaestro:draft-transport:v1:";

export interface DraftTransportHandle {
  resourceId: string;
  handle: string;
  expiresAt?: number;
}

export interface DraftTransportCache {
  version: 1;
  normal: DraftTransportHandle[];
  inline: DraftTransportHandle[];
  updatedAt: number;
}

export function draftTransportCacheKey(accountEmail: string, draftId: string): string {
  return `${PREFIX}${encodeURIComponent(accountEmail)}:${draftId}`;
}

function validEntry(value: unknown, now: number): value is DraftTransportHandle {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.resourceId === "string" &&
    entry.resourceId.length > 0 &&
    typeof entry.handle === "string" &&
    entry.handle.length > 0 &&
    (entry.expiresAt === undefined ||
      (typeof entry.expiresAt === "number" && entry.expiresAt > now + 5_000))
  );
}

/** Read-only local transport reuse. It never validates handles over the network. */
export function readDraftTransportCache(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
  now: () => number = () => Date.now(),
): DraftTransportCache | null {
  try {
    const raw = storage.getItem(draftTransportCacheKey(accountEmail, draftId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1) return null;
    const current = now();
    const normal = Array.isArray(parsed.normal)
      ? parsed.normal.filter((entry) => validEntry(entry, current))
      : [];
    const inline = Array.isArray(parsed.inline)
      ? parsed.inline.filter((entry) => validEntry(entry, current))
      : [];
    return {
      version: 1,
      normal,
      inline,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : current,
    };
  } catch {
    return null;
  }
}

export function writeDraftTransportCache(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
  cache: Omit<DraftTransportCache, "version" | "updatedAt">,
  now: () => number = () => Date.now(),
): boolean {
  try {
    storage.setItem(
      draftTransportCacheKey(accountEmail, draftId),
      JSON.stringify({ version: 1, ...cache, updatedAt: now() } satisfies DraftTransportCache),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearDraftTransportCache(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
): void {
  try {
    storage.removeItem(draftTransportCacheKey(accountEmail, draftId));
  } catch {
    /* best effort */
  }
}
