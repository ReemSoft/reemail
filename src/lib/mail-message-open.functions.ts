// Cache-first message open + bounded background body warmer.
//
// Cache HIT  : browser → server fn → Postgres (body cache) → browser.
//              ZERO bridge calls, ZERO IMAP connections.
// Cache MISS : browser → server fn → bridge (interactive lane) → IMAP →
//              browser, then the body is persisted for the next click.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailAttachment, MailMessage } from "@/lib/mail-types";
import {
  classifyBridgeMessageFailure,
  type BridgeMessageErrorCode,
} from "@/lib/mail-bridge-error";

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

const OpenSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  password: z.string().min(1).max(1024),
  folder: FolderSchema,
  uid: z.number().int().positive(),
  /** Set false when the caller has no index row to merge a cached body into. */
  allowCache: z.boolean().optional().default(true),
});

export interface CachedBodyPayload {
  bodyHtml: string;
  preview: string;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  attachments: MailAttachment[];
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

export const openMailMessage = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof OpenSchema>) => OpenSchema.parse(v))
  .handler(async ({ data }): Promise<OpenMessageResult> => {
    const t0 = Date.now();
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cache = await import("@/lib/mail-body-cache.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
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

    const key = {
      companyId: auth.companyId,
      accountId: auth.accountId,
      canonical: data.folder,
      uid: data.uid,
    };

    if (data.allowCache && cache.isCacheableFolder(data.folder)) {
      const tRead = Date.now();
      const found = await cache.lookupCachedBody(supabaseAdmin, key).catch(() => null);
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
            attachments: found.body.attachments,
            uidValidity: found.body.uidValidity,
          },
        };
      }
      console.log(`[body-cache] miss reason=${found?.hit === false ? found.reason : "error"}`);
    }

    const tImap = Date.now();
    const r = await bridgeCallResolved(
      auth,
      "/api/message",
      { folder: data.folder, uid: data.uid, lane: "interactive" },
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

    if (msg.uidValidity && cache.isCacheableFolder(data.folder)) {
      void cache
        .storeCachedBody(supabaseAdmin, {
          ...key,
          uidValidity: msg.uidValidity,
          bodyHtml: msg.body || "",
          preview: msg.preview || "",
          inlineParts: msg.inlineParts ?? [],
          attachments: msg.attachments ?? [],
        })
        .catch(() => undefined);
    }

    console.log(`[message-open] total ${Date.now() - t0}ms source=imap`);
    return { ok: true, source: "imap", message: msg, body: null };
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
  .handler(async ({ data }): Promise<{ ok: boolean; warmed: number }> => {
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cache = await import("@/lib/mail-body-cache.server");
    const { bridgeCallResolved } = await import("@/lib/mail-bridge-call.server");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok) return { ok: false, warmed: 0 };
    if (!cache.isCacheableFolder(data.folder)) return { ok: true, warmed: 0 };

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
    if (!folderRow?.uidvalidity) return { ok: true, warmed: 0 };

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
    if (!uids.length) return { ok: true, warmed: 0 };

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

    const todo = uids.filter((u) => !have.has(u)).slice(0, limits.warmBatch);
    let warmed = 0;
    // Strictly sequential: one background body at a time per account.
    for (const uid of todo) {
      const r = await bridgeCallResolved(
        auth,
        "/api/message",
        { folder: data.folder, uid, lane: "background" },
        data.password,
      );
      if (!r.ok) break;
      const msg = (r.json.message as MailMessage | null) ?? null;
      if (!msg?.uidValidity) continue;
      const outcome = await cache.storeCachedBody(supabaseAdmin, {
        companyId: auth.companyId,
        accountId: auth.accountId,
        canonical: data.folder,
        uid,
        uidValidity: msg.uidValidity,
        bodyHtml: msg.body || "",
        preview: msg.preview || "",
        inlineParts: msg.inlineParts ?? [],
        attachments: msg.attachments ?? [],
      });
      if (outcome === "stored") warmed++;
    }

    await cache
      .cleanupBodyCache(supabaseAdmin, {
        companyId: auth.companyId,
        accountId: auth.accountId,
      })
      .catch(() => 0);

    return { ok: true, warmed };
  });
