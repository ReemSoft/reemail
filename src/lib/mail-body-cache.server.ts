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
import type { MailAddress, MailAttachment, MailMessage } from "@/lib/mail-types";
import { INLINE_CID_MAX_COUNT, partitionInlineCidParts } from "@/lib/mail-inline-cid-policy";

/** Bump when the HTML/body pipeline changes: invalidates every stored body. */
export const BODY_CACHE_VERSION = 3;

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

/** Provenance header rows shown under the message header (Gmail-style). */
export interface CachedHeadersMeta {
  mailedBy?: string;
  signedBy?: string;
  security?: string;
  replyTo?: MailAddress[];
}

export interface CachedBody {
  bodyHtml: string;
  preview: string;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  inlineImages: NonNullable<MailMessage["inlineImages"]>;
  attachments: MailAttachment[];
  headersMeta?: CachedHeadersMeta;
  uidValidity: string;
  byteSize: number;
}

export interface MailboxHint {
  folderId: string;
  path: string;
  expectedUidValidity: string;
}

export type CacheLookup =
  | { hit: true; body: CachedBody }
  | {
      hit: false;
      reason: "no-folder" | "no-row" | "uidvalidity" | "orphan" | "oversize" | "no-headers";
    };

export interface CacheLookupContext {
  lookup: CacheLookup;
  mailboxHint?: MailboxHint;
}

export interface CacheKey {
  companyId: string;
  accountId: string;
  canonical: string;
  uid: number;
}

function boundedInlineParts(
  value: unknown,
  embeddedCids: Iterable<string> = [],
): CachedBody["inlineParts"] {
  if (!Array.isArray(value)) return [];
  const candidates = value.filter(
    (candidate): candidate is CachedBody["inlineParts"][number] =>
      Boolean(candidate) && typeof candidate === "object",
  );
  const partition = partitionInlineCidParts(candidates, embeddedCids);
  return [
    ...partition.smallBatchParts,
    ...partition.largeStreamParts,
    ...partition.overflowStreamParts,
  ].slice(0, INLINE_CID_MAX_COUNT);
}

function normalizeCid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return normalized || null;
}

function referencedImageCids(bodyHtml: string): Set<string> {
  const cids = new Set<string>();
  const imageCidSource =
    /<img\b[^>]*\bsrc\s*=\s*(?:"\s*cid:([^"]*)"|'\s*cid:([^']*)'|cid:([^\s>]+))/gi;
  for (const match of bodyHtml.matchAll(imageCidSource)) {
    const cid = normalizeCid(match[1] ?? match[2] ?? match[3]);
    if (cid) cids.add(cid);
  }
  return cids;
}

function normalizeCachedInlineMetadata(
  bodyHtml: string,
  inlinePartsValue: unknown,
  attachmentsValue: unknown,
): Pick<CachedBody, "inlineParts" | "attachments"> {
  const inlineParts = boundedInlineParts(inlinePartsValue);
  const attachments = Array.isArray(attachmentsValue) ? (attachmentsValue as MailAttachment[]) : [];
  const referencedCids = referencedImageCids(bodyHtml);
  if (referencedCids.size === 0 || attachments.length === 0) {
    return { inlineParts, attachments };
  }

  const legacyCandidates: CachedBody["inlineParts"] = [];
  for (const attachment of attachments) {
    const cid = normalizeCid(attachment.contentId);
    if (!cid || !referencedCids.has(cid)) continue;
    legacyCandidates.push({
      cid,
      part: attachment.part ?? "",
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
  }

  const recoveredInlineParts = boundedInlineParts(
    legacyCandidates,
    inlineParts.map((part) => part.cid),
  ).slice(0, Math.max(0, INLINE_CID_MAX_COUNT - inlineParts.length));
  const mergedInlineParts = boundedInlineParts([...inlineParts, ...recoveredInlineParts]);
  const acceptedCids = new Set(
    mergedInlineParts.map((part) => normalizeCid(part.cid)).filter((cid): cid is string => !!cid),
  );
  return {
    inlineParts: mergedInlineParts,
    attachments: attachments.filter((attachment) => {
      const cid = normalizeCid(attachment.contentId);
      return !cid || !referencedCids.has(cid) || !acceptedCids.has(cid);
    }),
  };
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
export async function lookupCachedBodyWithMailboxHint(
  supabase: SupabaseClient,
  key: CacheKey,
): Promise<CacheLookupContext> {
  const [folderRes, rowRes] = await Promise.all([
    supabase
      .from("mail_folders")
      .select("id, uidvalidity, path")
      .eq("company_id", key.companyId)
      .eq("account_id", key.accountId)
      .eq("canonical", key.canonical)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("mail_message_body_cache")
      .select(
        "uid_validity, body_html, body_text, preview, inline_parts, inline_images, attachments, headers_meta, byte_size, oversize",
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

  const folder = folderRes.data as {
    id: string;
    uidvalidity: number | null;
    path: string | null;
  } | null;
  const row = rowRes.data as {
    uid_validity: number;
    body_html: string | null;
    body_text: string | null;
    preview: string | null;
    inline_parts: unknown;
    inline_images: unknown;
    attachments: unknown;
    headers_meta: unknown;
    byte_size: number;
    oversize: boolean;
  } | null;

  const mailboxHint =
    folder?.id &&
    folder.uidvalidity != null &&
    Number(folder.uidvalidity) > 0 &&
    typeof folder.path === "string" &&
    folder.path.trim()
      ? {
          folderId: folder.id,
          path: folder.path,
          expectedUidValidity: String(folder.uidvalidity),
        }
      : undefined;

  if (!folder || folder.uidvalidity == null) {
    return { lookup: { hit: false, reason: "no-folder" } };
  }
  if (!row) return { lookup: { hit: false, reason: "no-row" }, mailboxHint };
  if (Number(row.uid_validity) !== Number(folder.uidvalidity)) {
    return { lookup: { hit: false, reason: "uidvalidity" }, mailboxHint };
  }
  if (row.oversize || (!row.body_html && !row.body_text)) {
    return { lookup: { hit: false, reason: "oversize" }, mailboxHint };
  }
  // Rows cached before provenance headers were persisted lack `headers_meta`.
  // Treat them as a miss exactly once: the live fetch re-stores a complete
  // row, so the mailed-by / signed-by / security lines come back for good
  // without invalidating the whole cache.
  if (row.headers_meta == null) {
    return { lookup: { hit: false, reason: "no-headers" }, mailboxHint };
  }

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
  if (!live.data) return { lookup: { hit: false, reason: "orphan" }, mailboxHint };

  const bodyHtml = row.body_html ?? row.body_text ?? "";
  const normalizedInlineMetadata = normalizeCachedInlineMetadata(
    bodyHtml,
    row.inline_parts,
    row.attachments,
  );

  return {
    lookup: {
      hit: true,
      body: {
        bodyHtml,
        preview: row.preview ?? "",
        inlineParts: normalizedInlineMetadata.inlineParts,
        inlineImages: Array.isArray(row.inline_images)
          ? (row.inline_images as CachedBody["inlineImages"])
          : [],
        attachments: normalizedInlineMetadata.attachments,
        headersMeta: sanitizeHeadersMeta(row.headers_meta),
        uidValidity: String(row.uid_validity),
        byteSize: row.byte_size,
      },
    },
    mailboxHint,
  };
}

export async function lookupCachedBody(
  supabase: SupabaseClient,
  key: CacheKey,
): Promise<CacheLookup> {
  return (await lookupCachedBodyWithMailboxHint(supabase, key)).lookup;
}

/** Three bounded queries for an entire visible prefetch window (folder, cache,
 * live identities), instead of repeating the single-message lookup pipeline. */
export async function lookupCachedBodies(
  supabase: SupabaseClient,
  scope: Omit<CacheKey, "uid">,
  uids: number[],
): Promise<{ hits: Map<number, CachedBody>; mailboxHint?: MailboxHint }> {
  const requested = [...new Set(uids.filter((uid) => Number.isInteger(uid) && uid > 0))].slice(
    0,
    12,
  );
  const hits = new Map<number, CachedBody>();
  if (!requested.length) return { hits };

  const folderResult = await supabase
    .from("mail_folders")
    .select("id, uidvalidity, path")
    .eq("company_id", scope.companyId)
    .eq("account_id", scope.accountId)
    .eq("canonical", scope.canonical)
    .limit(1)
    .maybeSingle();
  const folder = folderResult.data as {
    id: string;
    uidvalidity: number | null;
    path: string | null;
  } | null;
  if (!folder?.id || !folder.uidvalidity) return { hits };
  const mailboxHint = folder.path?.trim()
    ? {
        folderId: folder.id,
        path: folder.path,
        expectedUidValidity: String(folder.uidvalidity),
      }
    : undefined;

  const [rowsResult, liveResult] = await Promise.all([
    supabase
      .from("mail_message_body_cache")
      .select(
        "uid, uid_validity, body_html, body_text, preview, inline_parts, inline_images, attachments, headers_meta, byte_size, oversize",
      )
      .eq("company_id", scope.companyId)
      .eq("account_id", scope.accountId)
      .eq("canonical", scope.canonical)
      .eq("uid_validity", folder.uidvalidity)
      .eq("cache_version", BODY_CACHE_VERSION)
      .in("uid", requested),
    supabase
      .from("mail_messages")
      .select("uid")
      .eq("company_id", scope.companyId)
      .eq("account_id", scope.accountId)
      .eq("folder_id", folder.id)
      .eq("uidvalidity", folder.uidvalidity)
      .is("deleted_at", null)
      .in("uid", requested),
  ]);
  const live = new Set(
    ((liveResult.data ?? []) as { uid: number }[]).map((row) => Number(row.uid)),
  );
  type BatchRow = {
    uid: number;
    uid_validity: number;
    body_html: string | null;
    body_text: string | null;
    preview: string | null;
    inline_parts: unknown;
    inline_images: unknown;
    attachments: unknown;
    headers_meta: unknown;
    byte_size: number;
    oversize: boolean;
  };
  for (const row of (rowsResult.data ?? []) as BatchRow[]) {
    const uid = Number(row.uid);
    if (
      !live.has(uid) ||
      row.oversize ||
      row.headers_meta == null ||
      (!row.body_html && !row.body_text)
    ) {
      continue;
    }
    const bodyHtml = row.body_html ?? row.body_text ?? "";
    const metadata = normalizeCachedInlineMetadata(bodyHtml, row.inline_parts, row.attachments);
    hits.set(uid, {
      bodyHtml,
      preview: row.preview ?? "",
      inlineParts: metadata.inlineParts,
      inlineImages: Array.isArray(row.inline_images)
        ? (row.inline_images as CachedBody["inlineImages"])
        : [],
      attachments: metadata.attachments,
      headersMeta: sanitizeHeadersMeta(row.headers_meta),
      uidValidity: String(row.uid_validity),
      byteSize: row.byte_size,
    });
  }
  return { hits, mailboxHint };
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
  bodyTruncated?: boolean;
  preview: string;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  inlineImages?: NonNullable<MailMessage["inlineImages"]>;
  attachments: MailAttachment[];
  headersMeta?: CachedHeadersMeta;
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
  const oversize = input.bodyTruncated === true || byteSize > limits.maxBytes;
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
      attachments: input.attachments ?? [],
      headers_meta: sanitizeHeadersMeta(input.headersMeta),
      byte_size: byteSize,
      oversize,
      cached_at: now,
      last_accessed_at: now,
      // Only embedded images are written here. A body refresh that carries no
      // inline images (the deferred-CID open path) leaves the column untouched
      // so a racing or later `storeCachedInlineImages` batch is never wiped;
      // new rows still default to `[]` from the schema.
      ...(images.length > 0 ? { inline_images: keepImages ? images : [] } : {}),
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

function sanitizeHeadersMeta(value: unknown): CachedHeadersMeta {
  const v = (value ?? {}) as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const raw = v[k];
    return typeof raw === "string" && raw.trim() ? raw.slice(0, 256) : undefined;
  };
  const replyTo = Array.isArray(v.replyTo)
    ? v.replyTo.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const record = candidate as Record<string, unknown>;
        const email = typeof record.email === "string" ? record.email.trim() : "";
        if (!email || /[\r\n]/.test(email) || !/^[^\s@]+@[^\s@]+$/.test(email)) return [];
        const name =
          typeof record.name === "string" ? record.name.replace(/[\r\n]+/g, " ").slice(0, 200) : "";
        return [{ name, email }];
      })
    : [];
  return {
    mailedBy: pick("mailedBy"),
    signedBy: pick("signedBy"),
    security: pick("security"),
    replyTo: replyTo.length ? replyTo.slice(0, 20) : undefined,
  };
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
