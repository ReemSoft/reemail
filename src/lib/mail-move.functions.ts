// Atomic Move server function. Verifies the Mail Session JWT, calls the
// Bridge, and applies the Local Mail Index write-through in one round.
//
// Auth model (identical to indexUpdateFlag): accountId/companyId come from
// verified JWT claims, never from client input. The bridge is called exactly
// once per invocation. Local index write-through happens after IMAP success.
// A DB failure NEVER rolls the UI back — IMAP is the source of truth.
//
// Client-safe by construction: all server-only imports live inside the
// handler and behind dynamic `await import(...)`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const CanonicalSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
    sourceCanonical: CanonicalSchema,
    destCanonical: CanonicalSchema,
    uid: z.number().int().positive(),
  })
  .strict();

export type IndexMoveInput = z.input<typeof InputSchema>;

export interface IndexMoveMoveInfo {
  sourceUid: number;
  destinationPath?: string;
  destinationUid?: number;
  destinationUidValidity?: string;
  uidMappingAvailable: boolean;
}

export type IndexMoveResult =
  | {
      ok: true;
      imap: true;
      move: IndexMoveMoveInfo;
      index: "full" | "source-only" | "no-source-folder" | "partial";
    }
  | { ok: false; error: string; code: string };

export const indexMoveMessage = createServerFn({ method: "POST" })
  .inputValidator((v: IndexMoveInput) => InputSchema.parse(v))
  .handler(async ({ data }): Promise<IndexMoveResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const {
      resolveMailConfigForAccount,
      MailAccountNotFoundError,
      MailAccountCompanyMismatchError,
      MailConfigIncompleteError,
    } = await import("@/lib/mail-config.server");
    const { applyMoveWriteThrough } = await import("@/lib/mail-move-writer.server");

    // 1) Verify JWT
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }
    const accountId = claims.sub;
    const companyId = claims.cid;

    // 2) Resolve config
    let cfg;
    try {
      cfg = await resolveMailConfigForAccount(supabaseAdmin, accountId, companyId);
    } catch (e) {
      if (e instanceof MailAccountNotFoundError)
        return { ok: false, error: "الحساب غير موجود.", code: e.code };
      if (e instanceof MailAccountCompanyMismatchError)
        return { ok: false, error: "تعارض هوية الحساب.", code: e.code };
      if (e instanceof MailConfigIncompleteError)
        return { ok: false, error: "إعدادات البريد غير مكتملة.", code: e.code };
      console.error("[indexMoveMessage] resolveConfig failed", e);
      return { ok: false, error: "تعذر تحميل الإعدادات.", code: "CONFIG_LOAD_FAILED" };
    }

    // 3) Call Bridge /api/move exactly once. IMAP is source of truth.
    const url = process.env.MAIL_BRIDGE_URL;
    const key = process.env.MAIL_BRIDGE_SECRET;
    if (!url || !key) {
      return { ok: false, error: "لم يتم ربط خادم البريد.", code: "BRIDGE_NOT_CONFIGURED" };
    }
    const bridgeBody = {
      account: {
        email_address: cfg.emailAddress,
        display_name: cfg.displayName,
        imap_host: cfg.imapHost,
        imap_port: cfg.imapPort,
        imap_secure: cfg.imapSecure,
        smtp_host: cfg.smtpHost,
        smtp_port: cfg.smtpPort,
        smtp_secure: cfg.smtpSecure,
      },
      password: data.password,
      folder: data.sourceCanonical,
      uid: data.uid,
      toFolder: data.destCanonical,
    };

    let move: IndexMoveMoveInfo;
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
        body: JSON.stringify(bridgeBody),
      });
      const text = await res.text();
      let json: { ok?: boolean; error?: string; move?: IndexMoveMoveInfo } = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (!res.ok || !json.ok) {
        return {
          ok: false,
          error: json.error || `Bridge error ${res.status}`,
          code: "BRIDGE_MOVE_FAILED",
        };
      }
      move = json.move ?? { sourceUid: data.uid, uidMappingAvailable: false };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Bridge unreachable",
        code: "BRIDGE_UNREACHABLE",
      };
    }

    // 4) Local Mail Index write-through. Best-effort — IMAP already succeeded.
    let indexStatus: "full" | "source-only" | "no-source-folder" | "partial" = "source-only";
    try {
      const outcome = await applyMoveWriteThrough(supabaseAdmin, {
        accountId,
        companyId,
        sourceCanonical: data.sourceCanonical,
        destCanonical: data.destCanonical,
        sourceUid: data.uid,
        destinationPath: move.destinationPath,
        destinationUid: move.destinationUid,
        destinationUidValidity: move.destinationUidValidity,
        uidMappingAvailable: move.uidMappingAvailable,
      });
      if (outcome.ok) indexStatus = outcome.applied;
    } catch (e) {
      console.error("[indexMoveMessage] index write-through failed after IMAP success", e);
      indexStatus = "partial";
    }

    return { ok: true, imap: true, move, index: indexStatus };
  });
