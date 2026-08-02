import type { MailMessage } from "@/lib/mail-types";

export const DEFAULT_MESSAGE_CACHE_MAX_ROWS = 25;
export const DEFAULT_MESSAGE_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MESSAGE_CACHE_TTL_MS = 20 * 60 * 1000;

export interface MessageCacheScope {
  companyId: string;
  accountId: string;
}

export interface MessageCacheLimits {
  maxRows?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  message: MailMessage;
  storedAt: number;
  size: number;
}

export interface MessageCacheStats {
  rows: number;
  bytes: number;
  evictions: number;
}

function parseMessageId(id: string): { folder: string; uid: number } | null {
  const match = /^([^:]+):(\d+)$/.exec(id);
  if (!match) return null;
  const uid = Number(match[2]);
  return Number.isSafeInteger(uid) && uid > 0 ? { folder: match[1], uid } : null;
}

function logicalKey(scope: MessageCacheScope, folder: string, uid: number): string {
  return `${scope.companyId}|${scope.accountId}|${folder}|${uid}`;
}

export function validUidValidity(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n) return null;
  return BigInt(normalized).toString();
}

export function messageMemoryCacheKey(
  scope: MessageCacheScope,
  message: Pick<MailMessage, "id" | "folder" | "uidValidity">,
): string | null {
  const parsed = parseMessageId(message.id);
  if (!parsed) return null;
  const folder = parsed.folder || message.folder;
  const uidValidity = validUidValidity(message.uidValidity);
  if (!uidValidity) return null;
  return `${logicalKey(scope, folder, parsed.uid)}|${uidValidity}`;
}

export function estimateMessageBytes(message: MailMessage): number {
  let chars =
    message.body.length +
    message.preview.length +
    message.subject.length +
    message.from.name.length +
    message.from.email.length;
  for (const address of [...message.to, ...(message.cc ?? [])]) {
    chars += address.name.length + address.email.length;
  }
  for (const attachment of message.attachments ?? []) {
    chars +=
      attachment.id.length +
      attachment.filename.length +
      attachment.mimeType.length +
      (attachment.part?.length ?? 0) +
      (attachment.contentId?.length ?? 0) +
      64;
  }
  for (const part of message.inlineParts ?? []) {
    chars += part.cid.length + part.part.length + part.mimeType.length + 32;
  }
  for (const image of message.inlineImages ?? []) {
    chars +=
      image.cid.length + image.part.length + image.mimeType.length + image.dataUri.length + 32;
  }
  return Math.max(256, chars * 2);
}

export class MessageMemoryCache {
  private readonly rows = new Map<string, CacheEntry>();
  private readonly folderUidValidity = new Map<string, string>();
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private bytes = 0;
  private evictions = 0;

  constructor(limits: MessageCacheLimits = {}) {
    this.maxRows = limits.maxRows ?? DEFAULT_MESSAGE_CACHE_MAX_ROWS;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MESSAGE_CACHE_MAX_BYTES;
    this.ttlMs = limits.ttlMs ?? DEFAULT_MESSAGE_CACHE_TTL_MS;
    this.now = limits.now ?? (() => Date.now());
  }

  get(scope: MessageCacheScope, message: Pick<MailMessage, "id" | "folder" | "uidValidity">) {
    const parsed = parseMessageId(message.id);
    if (!parsed) return null;
    const folder = parsed.folder || message.folder;
    const uidValidity = validUidValidity(message.uidValidity);
    if (!uidValidity) return null;
    const known = this.folderUidValidity.get(`${scope.companyId}|${scope.accountId}|${folder}`);
    if (known && known !== uidValidity) return null;
    const key = messageMemoryCacheKey(scope, message);
    if (!key) return null;
    const entry = this.rows.get(key);
    if (!entry) return null;
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.removeKey(key, true);
      return null;
    }
    this.rows.delete(key);
    this.rows.set(key, entry);
    return entry.message;
  }

  set(scope: MessageCacheScope, message: MailMessage): boolean {
    const parsed = parseMessageId(message.id);
    const key = messageMemoryCacheKey(scope, message);
    if (!parsed || !key) return false;
    const folder = parsed.folder || message.folder;
    const uidValidity = validUidValidity(message.uidValidity)!;
    this.retainUidValidity(scope, folder, uidValidity);
    const previous = this.rows.get(key);
    if (previous) this.bytes -= previous.size;
    const size = estimateMessageBytes(message);
    this.rows.delete(key);
    this.rows.set(key, { message, storedAt: this.now(), size });
    this.bytes += size;
    this.evict();
    return this.rows.has(key);
  }

  delete(scope: MessageCacheScope, id: string): void {
    const parsed = parseMessageId(id);
    if (!parsed) return;
    const prefix = `${logicalKey(scope, parsed.folder, parsed.uid)}|`;
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(prefix)) this.removeKey(key, false);
    }
  }

  patch(scope: MessageCacheScope, id: string, patch: Partial<MailMessage>): void {
    const parsed = parseMessageId(id);
    if (!parsed) return;
    const prefix = `${logicalKey(scope, parsed.folder, parsed.uid)}|`;
    const match = [...this.rows.entries()].find(([key]) => key.startsWith(prefix));
    if (!match) return;
    this.set(scope, { ...match[1].message, ...patch });
  }

  clear(): void {
    this.rows.clear();
    this.folderUidValidity.clear();
    this.bytes = 0;
  }

  stats(): MessageCacheStats {
    this.pruneExpired();
    return { rows: this.rows.size, bytes: this.bytes, evictions: this.evictions };
  }

  retainUidValidity(scope: MessageCacheScope, folder: string, uidValidity: string): boolean {
    const valid = validUidValidity(uidValidity);
    if (!valid) return false;
    this.observeUidValidity(scope, folder, valid);
    return true;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.rows) {
      if (now - entry.storedAt > this.ttlMs) this.removeKey(key, true);
    }
  }

  private evict(): void {
    this.pruneExpired();
    while (this.rows.size > this.maxRows || this.bytes > this.maxBytes) {
      const oldest = this.rows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeKey(oldest, true);
    }
  }

  private removeKey(key: string, eviction: boolean): void {
    const entry = this.rows.get(key);
    if (!entry) return;
    this.rows.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.size);
    if (eviction) this.evictions++;
  }

  private observeUidValidity(scope: MessageCacheScope, folder: string, uidValidity: string): void {
    const folderKey = `${scope.companyId}|${scope.accountId}|${folder}`;
    const previous = this.folderUidValidity.get(folderKey);
    if (previous === uidValidity) return;
    this.folderUidValidity.set(folderKey, uidValidity);
    if (!previous) return;
    const prefix = `${folderKey}|`;
    for (const [key, entry] of [...this.rows.entries()]) {
      if (key.startsWith(prefix) && entry.message.uidValidity !== uidValidity) {
        this.removeKey(key, true);
      }
    }
  }
}
