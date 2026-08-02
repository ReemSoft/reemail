// Server-only body cache for opened messages.
//
// Contract (MAILMAESTRO_BODY_CACHE):
//   * IMAP stays the source of truth. The cache only short-circuits the
//     *body download* for a message whose (canonical, uid, uidvalidity)
//     identity is still present in the local index.
//   * The table is tenant isolated + deny-all to anon/authenticated. It is
//     only ever touched through the service-role client on the server.
//   * No credentials, no IMAP settings, no base64 image bytes are stored.
//   * `cache_version` invalidates every stored body when the HTML pipeline
//     changes.
//
// Logs are intentionally PII-free: no address, no subject, no uid, no
// account identifier is ever printed.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MailAttachment, MailMessage } from "@/lib/mail-types";

/** Bump when the HTML/body pipeline changes: invalidates every stored body. */
export const BODY_CACHE_VERSION = 2;

/** Folders whose bodies are never cached (drafts mutate in place). */
const NON_CACHEABLE = new Set(["drafts"]);

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface BodyCacheLimits {
  /** Largest body we are willing to persist. Bigger ones stay live-only. */
  maxBytes: number;
  /** Rows older than this are evicted. */
  maxAgeDays: number;
  /** Hard cap of cached bodies per account (LRU eviction). */
  maxRowsPerAccount: number;
  /** Bodies warmed per background invocation. */
  warmBatch: number;
  /** How many recent messages per account the warmer considers. */
  warmWindow: number;
  /** Largest total of embedded inline images we persist with a body. */
  inlineMaxBytes: number;
}

export function bodyCacheLimits(): BodyCacheLimits {
  return {
    maxBytes: envInt("MAIL_BODY_CACHE_MAX_BYTES", 512 * 1024),
    maxAgeDays: envInt("MAIL_BODY_CACHE_MAX_AGE_DAYS", 14),
    maxRowsPerAccount: envInt("MAIL_BODY_CACHE_MAX_ROWS", 100),
    warmBatch: envInt("MAIL_BODY_WARM_BATCH", 5),
    warmWindow: envInt("MAIL_BODY_WARM_WINDOW", 100),
    inlineMaxBytes: envInt("MAIL_BODY_CACHE_INLINE_MAX_BYTES", 1536 * 1024),
  };
}

export function isCacheableFolder(canonical: string): boolean {
  return !NON_CACHEABLE.has(canonical);
}

export interface CachedBody {
  bodyHtml: string;
  preview: string;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  inlineImages: NonNullable<MailMessage["inlineImages"]>;
  attachments: MailAttachment[];
  uidValidity: string;
  byteSize: number;
}

export type CacheLookup =
  | { hit: true; body: CachedBody }
  | { hit: false; reason: "no-folder" | "no-row" | "uidvalidity" | "orphan" | "oversize" };

export interface CacheKey {
  companyId: string;
  accountId: string;
  canonical: string;
  uid: number;
}

function boundedInlineParts(value: unknown): CachedBody["inlineParts"] {
  if (!Array.isArray(value)) return [];
  let totalBytes = 0;
  const output: CachedBody["inlineParts"] = [];
  for (const candidate of value as CachedBody["inlineParts"]) {
    if (output.length >= 20) break;
    if (
      !candidate ||
      typeof candidate.cid !== "string" ||
      !/^\d+(?:\.\d+)*$/.test(candidate.part) ||
      !/^image\//i.test(candidate.mimeType) ||
      !Number.isInteger(candidate.size) ||
      candidate.size < 0 ||
      candidate.size > 256 * 1024 ||
      totalBytes + candidate.size > 1024 * 1024
    ) {
      continue;
    }
    totalBytes += candidate.size;
    output.push(candidate);
  }
  return output;
}

/**
 * Cache read.
 *
 * Round 1 (parallel): current folder UIDVALIDITY + the cached row.
 * Round 2 (only on a candidate hit): the live index row must still exist,
 * so a deleted/moved message can never surface an orphan body.
 *
 * A different UIDVALIDITY makes the stored body unusable, by construction:
 * it is part of the unique key AND re-checked here.
 */
export async function lookupCachedBody(
  supabase: SupabaseClient,
  key: CacheKey,
): Promise<CacheLookup> {
  const [folderRes, rowRes] = await Promise.all([
    supabase
      .from("mail_folders")
      .select("id, uidvalidity")
      .eq("company_id", key.companyId)
      .eq("account_id", key.accountId)
      .eq("canonical", key.canonical)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("mail_message_body_cache")
      .select(
        "uid_validity, body_html, body_text, preview, inline_parts, inline_images, attachments, byte_size, oversize",
      )
      .eq("company_id", key.companyId)
      .eq("account_id", key.accountId)
      .eq("canonical", key.canonical)
      .eq("uid", key.uid)
      .eq("cache_version", BODY_CACHE_VERSION)
      .order("cached_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const folder = folderRes.data as { id: string; uidvalidity: number | null } | null;
  const row = rowRes.data as {
    uid_validity: number;
    body_html: string | null;
    body_text: string | null;
    preview: string | null;
    inline_parts: unknown;
    inline_images: unknown;
    attachments: unknown;
    byte_size: number;
    oversize: boolean;
  } | null;

  if (!folder || folder.uidvalidity == null) return { hit: false, reason: "no-folder" };
  if (!row) return { hit: false, reason: "no-row" };
  if (Number(row.uid_validity) !== Number(folder.uidvalidity)) {
    return { hit: false, reason: "uidvalidity" };
  }
  if (row.oversize || (!row.body_html && !row.body_text)) return { hit: false, reason: "oversize" };

  const live = await supabase
    .from("mail_messages")
    .select("id")
    .eq("company_id", key.companyId)
    .eq("account_id", key.accountId)
    .eq("folder_id", folder.id)
    .eq("uid", key.uid)
    .eq("uidvalidity", folder.uidvalidity)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (!live.data) return { hit: false, reason: "orphan" };

  return {
    hit: true,
    body: {
      bodyHtml: row.body_html ?? row.body_text ?? "",
      preview: row.preview ?? "",
      inlineParts: boundedInlineParts(row.inline_parts),
      inlineImages: Array.isArray(row.inline_images)
        ? (row.inline_images as CachedBody["inlineImages"])
        : [],
      attachments: Array.isArray(row.attachments) ? (row.attachments as MailAttachment[]) : [],
      uidValidity: String(row.uid_validity),
      byteSize: row.byte_size,
    },
  };
}

/** Non-blocking LRU touch. Never awaited on the response path. */
export function touchCachedBody(supabase: SupabaseClient, key: CacheKey): void {
  void supabase
    .from("mail_message_body_cache")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("company_id", key.companyId)
    .eq("account_id", key.accountId)
    .eq("canonical", key.canonical)
    .eq("uid", key.uid)
    .then(
      () => undefined,
      () => undefined,
    );
}

export interface StoreInput extends CacheKey {
  uidValidity: string | number;
  bodyHtml: string;
  preview: string;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  inlineImages?: NonNullable<MailMessage["inlineImages"]>;
  attachments: MailAttachment[];
}

/**
 * Persists a freshly fetched body. A body above the size limit is recorded
 * as `oversize` with NO content — never truncated — so the warmer stops
 * retrying it while the open path keeps fetching it live.
 */
export async function storeCachedBody(
  supabase: SupabaseClient,
  input: StoreInput,
  limits: BodyCacheLimits = bodyCacheLimits(),
): Promise<"stored" | "oversize" | "skipped"> {
  if (!isCacheableFolder(input.canonical)) return "skipped";
  const uidValidity = Number(input.uidValidity);
  if (!Number.isFinite(uidValidity) || uidValidity <= 0) return "skipped";

  const byteSize = byteLength(input.bodyHtml);
  const oversize = byteSize > limits.maxBytes;
  const now = new Date().toISOString();

  // Embedded inline images are persisted with the body so a cache hit paints
  // every logo with zero requests. Above the budget we keep the body and
  // demote the images to lazy metadata — never a broken image, never a row
  // that could grow without bound.
  const images = input.inlineImages ?? [];
  const imagesBytes = images.reduce((n, i) => n + byteLength(i.dataUri), 0);
  const keepImages = imagesBytes <= limits.inlineMaxBytes;
  const inlineParts = keepImages
    ? boundedInlineParts(input.inlineParts)
    : [
        ...boundedInlineParts(input.inlineParts),
        ...images.map((i) => ({
          cid: i.cid,
          part: i.part,
          mimeType: i.mimeType,
          size: i.size,
        })),
      ].slice(0, 20);

  const { error } = await supabase.from("mail_message_body_cache").upsert(
    {
      company_id: input.companyId,
      account_id: input.accountId,
      canonical: input.canonical,
      uid: input.uid,
      uid_validity: uidValidity,
      cache_version: BODY_CACHE_VERSION,
      body_html: oversize ? null : input.bodyHtml,
      body_text: null,
      preview: input.preview.slice(0, 512),
      inline_parts: inlineParts,
      inline_images: keepImages ? images : [],
      attachments: input.attachments ?? [],
      byte_size: byteSize,
      oversize,
      cached_at: now,
      last_accessed_at: now,
    },
    { onConflict: "company_id,account_id,canonical,uid,uid_validity" },
  );
  if (error) {
    console.warn("[body-cache] store failed");
    return "skipped";
  }
  console.log(
    `[body-cache] store bytes=${byteSize} oversize=${oversize} inlineBytes=${imagesBytes} inlineKept=${keepImages}`,
  );
  return oversize ? "oversize" : "stored";
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s || "").length;
}

/** Persist a completed deferred CID batch without rewriting the cached body. */
export async function storeCachedInlineImages(
  supabase: SupabaseClient,
  key: CacheKey,
  uidValidity: string | number,
  images: NonNullable<MailMessage["inlineImages"]>,
): Promise<"stored" | "skipped"> {
  const validity = Number(uidValidity);
  const totalBytes = images.reduce((sum, image) => sum + image.size, 0);
  const valid =
    Number.isFinite(validity) &&
    validity > 0 &&
    images.length <= 20 &&
    totalBytes <= 1024 * 1024 &&
    images.every(
      (image) =>
        image.size >= 0 &&
        image.size <= 256 * 1024 &&
        /^image\//i.test(image.mimeType) &&
        image.dataUri.startsWith(`data:${image.mimeType};base64,`),
    );
  if (!valid || !isCacheableFolder(key.canonical)) return "skipped";

  const { error } = await supabase
    .from("mail_message_body_cache")
    .update({ inline_images: images, last_accessed_at: new Date().toISOString() })
    .eq("company_id", key.companyId)
    .eq("account_id", key.accountId)
    .eq("canonical", key.canonical)
    .eq("uid", key.uid)
    .eq("uid_validity", validity)
    .eq("cache_version", BODY_CACHE_VERSION);
  if (error) {
    console.warn("[body-cache] inline store failed");
    return "skipped";
  }
  return "stored";
}

/** Age + count bounded eviction for one account. */
export async function cleanupBodyCache(
  supabase: SupabaseClient,
  params: { companyId: string; accountId: string },
  limits: BodyCacheLimits = bodyCacheLimits(),
): Promise<number> {
  let evicted = 0;
  const cutoff = new Date(Date.now() - limits.maxAgeDays * 86_400_000).toISOString();
  const byAge = await supabase
    .from("mail_message_body_cache")
    .delete()
    .eq("company_id", params.companyId)
    .eq("account_id", params.accountId)
    .lt("cached_at", cutoff)
    .select("id");
  evicted += byAge.data?.length ?? 0;

  const keep = await supabase
    .from("mail_message_body_cache")
    .select("id, last_accessed_at")
    .eq("company_id", params.companyId)
    .eq("account_id", params.accountId)
    .order("last_accessed_at", { ascending: false })
    .limit(limits.maxRowsPerAccount + 200);
  const rows = (keep.data ?? []) as { id: string }[];
  if (rows.length > limits.maxRowsPerAccount) {
    const stale = rows.slice(limits.maxRowsPerAccount).map((r) => r.id);
    const del = await supabase
      .from("mail_message_body_cache")
      .delete()
      .in("id", stale)
      .select("id");
    evicted += del.data?.length ?? 0;
  }
  if (evicted > 0) console.log(`[body-cache] evict count=${evicted}`);
  return evicted;
}
