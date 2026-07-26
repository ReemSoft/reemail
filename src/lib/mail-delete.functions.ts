// Atomic Permanent-Delete server function (Blocker 1).
//
// Contract:
//   * Only accepts `canonical === "trash"`. Any other folder is rejected
//     up-front — permanent delete belongs to Trash by product design and
//     the Bridge decider (`decideDeleteMode`) would otherwise silently
//     route to `messageMove`.
//   * Verifies the Mail Session JWT (identity comes from claims, never
//     from client input).
//   * Calls Bridge /api/delete exactly once. Validates the response is
//     `{ ok: true, kind: "permanent-delete", sourceUid }` — a
//     `moved-to-trash` response is treated as a failure so a
//     Bridge/version drift cannot fake a permanent delete.
//   * On IMAP success, tombstones the Local Index row and decrements
//     Trash counts via the approved atomic RPC. DB failure NEVER rolls
//     the UI back — IMAP is the source of truth.
//
// Client-safe by construction: all server-only imports live inside the
// handler behind dynamic `await import(...)`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
    // Locked to "trash": permanent delete outside Trash is not a supported flow.
    canonical: z.literal("trash"),
    uid: z.number().int().positive(),
  })
  .strict();

export type IndexDeleteInput = z.input<typeof InputSchema>;

export type IndexDeleteResult =
  | {
      ok: true;
      imap: true;
      sourceUid: number;
      index: "tombstoned" | "already-tombstoned" | "no-source-folder" | "partial";
    }
  | { ok: false; error: string; code: string };

export const indexDeleteMessage = createServerFn({ method: "POST" })
  .inputValidator((v: IndexDeleteInput) => InputSchema.parse(v))
  .handler(async ({ data }): Promise<IndexDeleteResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const {
      resolveMailConfigForAccount,
      MailAccountNotFoundError,
      MailAccountCompanyMismatchError,
      MailConfigIncompleteError,
    } = await import("@/lib/mail-config.server");
    const { applyDeleteWriteThrough } = await import("@/lib/mail-delete-writer.server");

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
      console.error("[indexDeleteMessage] resolveConfig failed", e);
      return { ok: false, error: "تعذر تحميل الإعدادات.", code: "CONFIG_LOAD_FAILED" };
    }

    // 3) Bridge /api/delete — permanent-delete branch.
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
      folder: data.canonical, // "trash" — Bridge decider maps to messageDelete
      uid: data.uid,
    };

    let sourceUid: number;
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
        body: JSON.stringify(bridgeBody),
      });
      const text = await res.text();
      let json: { ok?: boolean; error?: string; kind?: string; sourceUid?: number } = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (!res.ok || !json.ok) {
        return {
          ok: false,
          error: json.error || `Bridge error ${res.status}`,
          code: "BRIDGE_DELETE_FAILED",
        };
      }
      // Strict contract check: must be a permanent-delete acknowledgement.
      if (json.kind !== "permanent-delete") {
        return {
          ok: false,
          error: `Unexpected bridge kind: ${json.kind ?? "<missing>"}`,
          code: "BRIDGE_UNEXPECTED_KIND",
        };
      }
      sourceUid =
        typeof json.sourceUid === "number" && Number.isFinite(json.sourceUid)
          ? json.sourceUid
          : data.uid;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Bridge unreachable",
        code: "BRIDGE_UNREACHABLE",
      };
    }

    // 4) Local Mail Index write-through — best-effort after IMAP success.
    let indexStatus: IndexDeleteResult extends { index: infer T } ? T : never = "partial" as any;
    try {
      const outcome = await applyDeleteWriteThrough(supabaseAdmin, {
        accountId,
        companyId,
        sourceCanonical: data.canonical,
        sourceUid,
      });
      indexStatus = outcome.ok ? outcome.applied : "partial";
    } catch (e) {
      console.error("[indexDeleteMessage] index write-through failed after IMAP success", e);
      indexStatus = "partial";
    }

    return { ok: true, imap: true, sourceUid, index: indexStatus };
  });
