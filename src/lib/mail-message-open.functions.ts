// Cache-first message open + bounded background body warmer.
//
// Cache HIT  : browser → server fn → Postgres (body cache) → browser.
//              ZERO bridge calls, ZERO IMAP connections.
// Cache MISS : browser → server fn → bridge (interactive lane) → IMAP →
//              browser, then the body is persisted for the next click.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailAttachment, MailMessage } from "@/lib/mail-types";
import { classifyBridgeMessageFailure, type BridgeMessageErrorCode } from "@/lib/mail-bridge-error";
import { partitionInlineCidParts } from "@/lib/mail-inline-cid-policy";
import { getCloudflareWaitUntil, trackCloudflareWork } from "@/lib/cloudflare-wait-until.server";

const FolderSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

const OpenSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
    folder: FolderSchema,
    uid: z.number().int().positive(),
    lane: z.enum(["interactive", "background"]).optional().default("interactive"),
    /** Set false when the caller has no index row to merge a cached body into. */
    allowCache: z.boolean().optional().default(true),
    openIntentScope: z.string().uuid().optional(),
    openIntentGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .superRefine((value, context) => {
    if ((value.openIntentScope == null) !== (value.openIntentGeneration == null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete message-open intent" });
    }
  });

export interface CachedBodyPayload {
  bodyHtml: string;
  preview: string;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  inlineImages: NonNullable<MailMessage["inlineImages"]>;
  attachments: MailAttachment[];
  /** Gmail-style provenance rows: mailed-by / signed-by / security. */
  mailedBy?: string;
  signedBy?: string;
  security?: string;
  replyTo?: MailMessage["replyTo"];
  uidValidity: string;
}

export type OpenMessageResult =
  | { ok: true; source: "cache"; body: CachedBodyPayload; message: null }
  | { ok: true; source: "imap"; message: MailMessage; body: null }
  | {
      ok: false;
      code: BridgeMessageErrorCode;
      error: string;
      message: null;
      body: null;
      status?: number;
    };

const PrefetchWindowSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  password: z.string().min(1).max(1024),
  folder: FolderSchema,
  messages: z
    .array(
      z.object({
        uid: z.number().int().positive(),
        uidValidity: z
          .string()
          .regex(/^[1-9]\d*$/)
          .max(64),
      }),
    )
    .min(1)
    .max(12),
});

export interface PrefetchedMessageBody {
  uid: number;
  source: "cache" | "imap";
  body?: CachedBodyPayload;
  message?: MailMessage;
}

export const openMailMessage = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof OpenSchema>) => OpenSchema.parse(v))
  .handler(async ({ data }): Promise<OpenMessageResult> => {
    const t0 = Date.now();
    const { verifyBridgeAuthClaims, resolveBridgeAuthForVerifiedClaims } =
      await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cache = await import("@/lib/mail-body-cache.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");

    const claims = await verifyBridgeAuthClaims(data.mailSessionToken);
    if (!("sub" in claims)) {
      return {
        ok: false,
        code: classifyBridgeMessageFailure({
          status: claims.status,
          unavailable: claims.code === "BRIDGE_NOT_CONFIGURED",
        }),
        error: claims.error,
        message: null,
        body: null,
        status: claims.status,
      };
    }

    const key = {
      companyId: claims.cid,
      accountId: claims.sub,
      canonical: data.folder,
      uid: data.uid,
    };

    // Config resolution and cache lookup are independent once the verified
    // token supplied authoritative tenant/account identity. Start both now;
    // a complete cache hit never waits for account/config database work.
    const authPromise = resolveBridgeAuthForVerifiedClaims(claims).catch(() => ({
      ok: false as const,
      status: 500,
      error: "تعذر تحميل الإعدادات.",
      code: "CONFIG_LOAD_FAILED",
    }));
    let mailboxHint: { path: string; expectedUidValidity: string } | undefined;

    if (data.allowCache && cache.isCacheableFolder(data.folder)) {
      const tRead = Date.now();
      const context = await cache
        .lookupCachedBodyWithMailboxHint(supabaseAdmin, key)
        .catch(() => null);
      const found = context?.lookup ?? null;
      mailboxHint = context?.mailboxHint;
      console.log(`[message-open] cache-read ${Date.now() - tRead}ms`);
      if (found?.hit) {
        cache.touchCachedBody(supabaseAdmin, key);
        console.log("[body-cache] hit");
        console.log(`[message-open] total ${Date.now() - t0}ms source=cache`);
        return {
          ok: true,
          source: "cache",
          message: null,
          body: {
            bodyHtml: found.body.bodyHtml,
            preview: found.body.preview,
            inlineParts: found.body.inlineParts,
            inlineImages: found.body.inlineImages,
            attachments: found.body.attachments,
            mailedBy: found.body.headersMeta?.mailedBy,
            signedBy: found.body.headersMeta?.signedBy,
            security: found.body.headersMeta?.security,
            replyTo: found.body.headersMeta?.replyTo,
            uidValidity: found.body.uidValidity,
          },
        };
      }
      console.log(`[body-cache] miss reason=${found?.hit === false ? found.reason : "error"}`);
    }

    const auth = await authPromise;
    if (!auth.ok) {
      return {
        ok: false,
        code: classifyBridgeMessageFailure({
          status: auth.status,
          unavailable: auth.code === "BRIDGE_NOT_CONFIGURED",
        }),
        error: auth.error,
        message: null,
        body: null,
        status: auth.status,
      };
    }

    const tImap = Date.now();
    const r = await bridgeCallResolved(
      auth,
      "/api/message",
      {
        folder: data.folder,
        uid: data.uid,
        lane: data.lane,
        ...(data.openIntentScope && data.openIntentGeneration
          ? {
              openIntentScope: data.openIntentScope,
              openIntentGeneration: data.openIntentGeneration,
              openIntentCompanyId: auth.companyId,
              openIntentAccountId: auth.accountId,
            }
          : {}),
        ...(mailboxHint && data.folder !== "starred" && data.folder !== "all"
          ? {
              mailboxPathHint: mailboxHint.path,
              expectedUidValidity: mailboxHint.expectedUidValidity,
            }
          : {}),
      },
      data.password,
    );
    console.log(`[message-open] imap-fetch ${Date.now() - tImap}ms`);
    if (!r.ok) {
      console.log(`[message-open] total ${Date.now() - t0}ms source=error`);
      return {
        ok: false,
        code: classifyBridgeMessageFailure({ status: r.status, unavailable: r.unavailable }),
        error: r.error,
        message: null,
        body: null,
        status: r.status,
      };
    }
    const msg = (r.json.message as MailMessage | null) ?? null;
    if (!msg) {
      return {
        ok: false,
        code: "NOT_FOUND",
        error: "Message not found",
        message: null,
        body: null,
      };
    }

    if (r.json.shared !== true && msg.uidValidity && cache.isCacheableFolder(data.folder)) {
      trackCloudflareWork(
        cache.storeCachedBody(supabaseAdmin, {
          ...key,
          uidValidity: msg.uidValidity,
          bodyHtml: msg.body || "",
          bodyTruncated: msg.bodyTruncated,
          preview: msg.preview || "",
          inlineParts: msg.inlineParts ?? [],
          inlineImages: msg.inlineImages ?? [],
          attachments: msg.attachments ?? [],
          headersMeta: {
            mailedBy: msg.mailedBy,
            signedBy: msg.signedBy,
            security: msg.security,
            replyTo: msg.replyTo,
          },
        }),
      );
    }

    console.log(`[message-open] total ${Date.now() - t0}ms source=imap`);
    return { ok: true, source: "imap", message: msg, body: null };
  });

/** One client invocation and at most one Bridge invocation for a visible window. */
export const prefetchMessageWindow = createServerFn({ method: "POST" })
  .inputValidator((value: z.input<typeof PrefetchWindowSchema>) =>
    PrefetchWindowSchema.parse(value),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; messages: PrefetchedMessageBody[] }> => {
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cache = await import("@/lib/mail-body-cache.server");
    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok || !cache.isCacheableFolder(data.folder)) return { ok: false, messages: [] };

    const unique = [
      ...new Map(data.messages.map((message) => [message.uid, message] as const)).values(),
    ];
    const scope = {
      companyId: auth.companyId,
      accountId: auth.accountId,
      canonical: data.folder,
    };
    const cached = await cache.lookupCachedBodies(
      supabaseAdmin,
      scope,
      unique.map((message) => message.uid),
    );
    if (!cached.mailboxHint) return { ok: true, messages: [] };
    const expectedUidValidity = cached.mailboxHint.expectedUidValidity;
    const valid = unique.filter((message) => message.uidValidity === expectedUidValidity);
    const messages: PrefetchedMessageBody[] = [];
    for (const candidate of valid) {
      const hit = cached.hits.get(candidate.uid);
      if (!hit) continue;
      messages.push({
        uid: candidate.uid,
        source: "cache",
        body: {
          bodyHtml: hit.bodyHtml,
          preview: hit.preview,
          inlineParts: hit.inlineParts,
          inlineImages: hit.inlineImages,
          attachments: hit.attachments,
          mailedBy: hit.headersMeta?.mailedBy,
          signedBy: hit.headersMeta?.signedBy,
          security: hit.headersMeta?.security,
          replyTo: hit.headersMeta?.replyTo,
          uidValidity: hit.uidValidity,
        },
      });
    }

    const misses = valid.filter((candidate) => !cached.hits.has(candidate.uid));
    if (misses.length) {
      const response = await bridgeCallResolved(
        auth,
        "/api/messages-prefetch",
        { folder: data.folder, uids: misses.map((message) => message.uid) },
        data.password,
      );
      if (response.ok) {
        const results = Array.isArray(response.json.results) ? response.json.results : [];
        for (const item of results as Array<{ uid?: unknown; message?: unknown }>) {
          const uid = Number(item.uid);
          const message = item.message as MailMessage | null;
          if (!message || !Number.isInteger(uid) || message.uidValidity !== expectedUidValidity)
            continue;
          messages.push({ uid, source: "imap", message });
          trackCloudflareWork(
            cache.storeCachedBody(supabaseAdmin, {
              ...scope,
              uid,
              uidValidity: message.uidValidity,
              bodyHtml: message.body || "",
              bodyTruncated: message.bodyTruncated,
              preview: message.preview || "",
              inlineParts: message.inlineParts ?? [],
              inlineImages: message.inlineImages ?? [],
              attachments: message.attachments ?? [],
              headersMeta: {
                mailedBy: message.mailedBy,
                signedBy: message.signedBy,
                security: message.security,
                replyTo: message.replyTo,
              },
            }),
          );
        }
      }
    }
    return { ok: true, messages };
  });

const EntireMessageSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  password: z.string().min(1).max(1024),
  folder: FolderSchema,
  uid: z.number().int().positive(),
  uidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64),
});

export type OpenEntireMessageResult =
  | {
      ok: true;
      body: string;
      bodyTruncated: false;
      inlineParts: NonNullable<MailMessage["inlineParts"]>;
      uidValidity: string;
    }
  | {
      ok: false;
      code: "MESSAGE_BODY_TOO_LARGE" | "NOT_FOUND" | "STALE_MESSAGE" | "UNAVAILABLE";
      error: string;
    };

/** User-triggered only. Bypasses the persistent body cache in both directions. */
export const openEntireMailMessage = createServerFn({ method: "POST" })
  .inputValidator((value: z.input<typeof EntireMessageSchema>) => EntireMessageSchema.parse(value))
  .handler(async ({ data }): Promise<OpenEntireMessageResult> => {
    const { verifyBridgeAuthClaims, resolveBridgeAuthForVerifiedClaims } =
      await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");

    const claims = await verifyBridgeAuthClaims(data.mailSessionToken);
    if (!("sub" in claims)) {
      return { ok: false, code: "UNAVAILABLE", error: claims.error };
    }

    const authPromise = resolveBridgeAuthForVerifiedClaims(claims);
    const hintPromise =
      data.folder === "starred" || data.folder === "all"
        ? Promise.resolve(null)
        : supabaseAdmin
            .from("mail_folders")
            .select("path, uidvalidity")
            .eq("company_id", claims.cid)
            .eq("account_id", claims.sub)
            .eq("canonical", data.folder)
            .limit(1)
            .maybeSingle();
    const [auth, hintResult] = await Promise.all([authPromise, hintPromise]);
    if (!auth.ok) return { ok: false, code: "UNAVAILABLE", error: auth.error };

    const hintRow = hintResult?.data as { path: string | null; uidvalidity: number | null } | null;
    const mailboxHint =
      hintRow?.path?.trim() &&
      hintRow.uidvalidity != null &&
      /^[1-9]\d*$/.test(String(hintRow.uidvalidity))
        ? { path: hintRow.path, expectedUidValidity: String(hintRow.uidvalidity) }
        : undefined;

    const response = await bridgeCallResolved(
      auth,
      "/api/message-entire",
      {
        folder: data.folder,
        uid: data.uid,
        ...(mailboxHint
          ? {
              mailboxPathHint: mailboxHint.path,
              expectedUidValidity: mailboxHint.expectedUidValidity,
            }
          : {}),
      },
      data.password,
    );
    if (!response.ok) {
      return {
        ok: false,
        code:
          response.error === "MESSAGE_BODY_TOO_LARGE" ? "MESSAGE_BODY_TOO_LARGE" : "UNAVAILABLE",
        error: response.error,
      };
    }

    const uidValidity = String(response.json.uidValidity ?? "");
    if (uidValidity !== data.uidValidity) {
      return { ok: false, code: "STALE_MESSAGE", error: "Message identity changed" };
    }
    if (typeof response.json.body !== "string") {
      return { ok: false, code: "NOT_FOUND", error: "Message not found" };
    }
    return {
      ok: true,
      body: response.json.body,
      bodyTruncated: false,
      inlineParts: Array.isArray(response.json.inlineParts) ? response.json.inlineParts : [],
      uidValidity,
    };
  });

const InlinePartSchema = z.object({
  cid: z.string().min(1).max(998),
  part: z.string().regex(/^\d+(?:\.\d+)*$/),
  mimeType: z.string().regex(/^image\//i),
  size: z.number().int().min(0),
});

const InlineBatchSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  password: z.string().min(1).max(1024),
  folder: FolderSchema,
  uid: z.number().int().positive(),
  uidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64),
  parts: z.array(InlinePartSchema).max(20),
  // Only an interactive CID fetch persists resolved bytes into the body cache.
  // Background/prefetch callers pass false so they never populate the
  // persistent cache (and they never fetch CID bytes in the first place).
  persist: z.boolean().default(true),
});

export type ResolveInlineImagesResult =
  | {
      ok: true;
      images: NonNullable<MailMessage["inlineImages"]>;
      failedCids: string[];
      source: "cache" | "bridge" | "none";
    }
  | { ok: false; images: []; failedCids: string[]; error: string };

/** Protected cache-first server batch, invoked only after the body paints. */
export const resolveMessageInlineImages = createServerFn({ method: "POST" })
  .inputValidator((value: z.input<typeof InlineBatchSchema>) => InlineBatchSchema.parse(value))
  .handler(async ({ data }): Promise<ResolveInlineImagesResult> => {
    const waitUntil = getCloudflareWaitUntil();
    const partition = partitionInlineCidParts(data.parts);
    if (partition.smallBatchParts.length !== data.parts.length) {
      return {
        ok: false,
        images: [],
        failedCids: data.parts.map((part) => part.cid),
        error: "INLINE_BATCH_PART_OUT_OF_BOUNDS",
      };
    }
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cache = await import("@/lib/mail-body-cache.server");
    const resolver = await import("@/lib/mail-inline-images.server");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok) return { ok: false, images: [], failedCids: [], error: auth.error };

    const key = {
      companyId: auth.companyId,
      accountId: auth.accountId,
      canonical: data.folder,
      uid: data.uid,
    };
    const messageKey = `${auth.companyId}|${auth.accountId}|${data.folder}:${data.uid}:${data.uidValidity}`;

    try {
      const result = await resolver.resolveInlineImageBatchSingleFlight(messageKey, () =>
        resolver.resolveInlineImageBatch(partition.smallBatchParts, {
          lookup: async () => {
            const cached = await cache.lookupCachedBody(supabaseAdmin, key);
            return cached?.hit && cached.body.uidValidity === data.uidValidity
              ? cached
              : { hit: false, reason: "uidvalidity" };
          },
          fetchBatch: async (parts) => {
            const response = await bridgeCallResolved(
              auth,
              "/api/message-inline-images",
              {
                folder: data.folder,
                uid: data.uid,
                expectedUidValidity: data.uidValidity,
                parts,
              },
              data.password,
            );
            if (!response.ok) throw new Error("INLINE_BATCH_FAILED");
            return {
              images: (response.json.images ?? []) as NonNullable<MailMessage["inlineImages"]>,
              failedCids: (response.json.failedCids ?? []) as string[],
            };
          },
          store: data.persist
            ? (uidValidity, images) => {
                const promise = cache.storeCachedInlineImages(
                  supabaseAdmin,
                  key,
                  uidValidity,
                  images,
                );
                // Register the write with the worker lifecycle so the resolve
                // request can return (and render) before persistence finishes
                // without the write being terminated after the response.
                waitUntil?.(promise);
                return promise;
              }
            : async () => undefined,
        }),
      );
      return { ok: true, ...result };
    } catch {
      return { ok: false, images: [], failedCids: [], error: "INLINE_BATCH_FAILED" };
    }
  });

const WarmSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  password: z.string().min(1).max(1024),
  folder: FolderSchema,
});

/**
 * Bounded background warmer.
 *
 * Runs strictly on the bridge's `background` lane (its own IMAP connection
 * and its own gate queue), fetches ONE body at a time and never more than
 * `MAIL_BODY_WARM_BATCH` per invocation, so it can not delay a user click.
 */
export const warmMessageBodies = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof WarmSchema>) => WarmSchema.parse(v))
  .handler(async ({ data }): Promise<{ ok: boolean; warmed: number; remaining: number }> => {
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cache = await import("@/lib/mail-body-cache.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok) return { ok: false, warmed: 0, remaining: 0 };
    if (!cache.isCacheableFolder(data.folder)) return { ok: true, warmed: 0, remaining: 0 };

    const limits = cache.bodyCacheLimits();
    const folder = await supabaseAdmin
      .from("mail_folders")
      .select("id, uidvalidity")
      .eq("company_id", auth.companyId)
      .eq("account_id", auth.accountId)
      .eq("canonical", data.folder)
      .limit(1)
      .maybeSingle();
    const folderRow = folder.data as { id: string; uidvalidity: number | null } | null;
    if (!folderRow?.uidvalidity) return { ok: true, warmed: 0, remaining: 0 };

    const recent = await supabaseAdmin
      .from("mail_messages")
      .select("uid")
      .eq("company_id", auth.companyId)
      .eq("account_id", auth.accountId)
      .eq("folder_id", folderRow.id)
      .eq("uidvalidity", folderRow.uidvalidity)
      .is("deleted_at", null)
      .order("internal_date", { ascending: false })
      .limit(limits.warmWindow);
    const uids = ((recent.data ?? []) as { uid: number }[]).map((r) => Number(r.uid));
    if (!uids.length) return { ok: true, warmed: 0, remaining: 0 };

    const cached = await supabaseAdmin
      .from("mail_message_body_cache")
      .select("uid")
      .eq("company_id", auth.companyId)
      .eq("account_id", auth.accountId)
      .eq("canonical", data.folder)
      .eq("uid_validity", folderRow.uidvalidity)
      .eq("cache_version", cache.BODY_CACHE_VERSION)
      .in("uid", uids.slice(0, limits.warmWindow));
    const have = new Set(((cached.data ?? []) as { uid: number }[]).map((r) => Number(r.uid)));

    const missing = uids.filter((u) => !have.has(u));
    const todo = missing.slice(0, limits.warmBatch);
    let warmed = 0;
    const batch = todo.length
      ? await bridgeCallResolved(
          auth,
          "/api/messages-prefetch",
          { folder: data.folder, uids: todo },
          data.password,
        )
      : null;
    const results = batch?.ok && Array.isArray(batch.json.results) ? batch.json.results : [];
    for (const item of results as Array<{ uid?: unknown; message?: unknown }>) {
      const uid = Number(item.uid);
      const msg = item.message as MailMessage | null;
      if (!Number.isInteger(uid) || !msg?.uidValidity) continue;
      const outcome = await cache.storeCachedBody(supabaseAdmin, {
        companyId: auth.companyId,
        accountId: auth.accountId,
        canonical: data.folder,
        uid,
        uidValidity: msg.uidValidity,
        bodyHtml: msg.body || "",
        bodyTruncated: msg.bodyTruncated,
        preview: msg.preview || "",
        inlineParts: msg.inlineParts ?? [],
        inlineImages: msg.inlineImages ?? [],
        attachments: msg.attachments ?? [],
        headersMeta: {
          mailedBy: msg.mailedBy,
          signedBy: msg.signedBy,
          security: msg.security,
          replyTo: msg.replyTo,
        },
      });
      if (outcome === "stored") warmed++;
    }

    await cache
      .cleanupBodyCache(supabaseAdmin, {
        companyId: auth.companyId,
        accountId: auth.accountId,
      })
      .catch(() => 0);

    return { ok: true, warmed, remaining: Math.max(0, missing.length - todo.length) };
  });
