// Blocker 3 — Ghost Message Cleanup server function.
//
// Contract:
//   * Invoked ONLY by the UI when Bridge /api/message returns a proven-
//     absent response (typed BridgeMessageErrorCode === "NOT_FOUND" — HTTP
//     404 from IMAP FETCH-then-empty). Never call from a NETWORK / AUTH /
//     TIMEOUT / UNKNOWN failure; those are transient and cleaning up would
//     silently destroy the Local Mail Index row.
//   * Delegates to `applyDeleteWriteThrough`, which is:
//       - IDEMPOTENT: a duplicate cleanup call for the same source row is
//         a no-op (the tombstone conditional UPDATE flips `deleted_at`
//         only once; subsequent callers see `changed:false`).
//       - ATOMIC: counter decrement runs through the approved RPC
//         `public.adjust_mail_folder_counts_atomic` — no Read-Modify-Write,
//         no negative counts.
//       - SCOPED: verifies (companyId, accountId, folderId, uidvalidity,
//         uid). The JWT provides companyId + accountId; the folder is
//         resolved by canonical inside the writer with company/account
//         filters. A stray tenant row cannot be tombstoned by mistake.
//   * Returns a structured outcome so the UI can log/observe without
//     surfacing a generic "failed to open" error to the user.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    // Restrict to canonical folders the UI can legitimately open a message
    // from. `starred` is a virtual view over INBOX; the writer normalizes
    // it internally. `all` is not a physical folder we tombstone through.
    canonical: z.enum(["inbox", "starred", "sent", "drafts", "spam", "trash", "archive"]),
    uid: z.number().int().positive(),
    /**
     * Trusted by the server ONLY for observability + strict scoping. The
     * writer scopes the tombstone update to the folder row resolved by
     * (accountId, companyId, canonical), which is the authoritative
     * identity. `uidvalidity` mismatch here is treated as a "no match"
     * (idempotent no-op) and never decrements counters.
     */
    uidvalidity: z.number().int().positive().optional(),
  })
  .strict();

export type GhostCleanupInput = z.input<typeof InputSchema>;

export type GhostCleanupResult =
  | {
      ok: true;
      applied: "tombstoned" | "already-tombstoned" | "no-source-folder" | "uidvalidity-mismatch";
      countsDecremented: boolean;
    }
  | { ok: false; error: string; code: string };

export const tombstoneGhostMessage = createServerFn({ method: "POST" })
  .inputValidator((v: GhostCleanupInput) => InputSchema.parse(v))
  .handler(async ({ data }): Promise<GhostCleanupResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const { applyDeleteWriteThrough } = await import("@/lib/mail-delete-writer.server");
    const { resolveFolderByCanonical } = await import("@/lib/mail-move-writer.server");

    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }
    const accountId = claims.sub;
    const companyId = claims.cid;

    // UIDVALIDITY mismatch guard — server is authoritative for the current
    // folder's UIDVALIDITY. If the caller sends a stale one, treat as a
    // proven mismatch and return without touching counters (the next sync
    // will reconcile the row anyway).
    if (data.uidvalidity != null) {
      try {
        const folder = await resolveFolderByCanonical(
          supabaseAdmin,
          accountId,
          companyId,
          data.canonical,
        );
        if (folder?.uidvalidity != null && folder.uidvalidity !== data.uidvalidity) {
          return {
            ok: true,
            applied: "uidvalidity-mismatch",
            countsDecremented: false,
          };
        }
      } catch (e) {
        // A resolution failure here should NOT block the cleanup — the
        // writer will re-resolve and return no-source-folder cleanly.
        console.warn("[ghost-cleanup] uidvalidity precheck skipped:", e);
      }
    }

    try {
      const outcome = await applyDeleteWriteThrough(supabaseAdmin, {
        accountId,
        companyId,
        sourceCanonical: data.canonical,
        sourceUid: data.uid,
        // Carry the exact generation proven by the caller through the final
        // tombstone. The precheck above is not a race fence by itself: the
        // folder row can advance to a new UIDVALIDITY between that SELECT and
        // this write-through re-resolution. Binding the source generation here
        // makes a reset in that window a safe no-op instead of reusing the same
        // numeric UID against the new generation.
        sourceUidValidity: data.uidvalidity,
      });
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, code: "GHOST_CLEANUP_WRITE_FAILED" };
      }
      return {
        ok: true,
        applied: outcome.applied,
        countsDecremented: outcome.applied === "tombstoned",
      };
    } catch (e) {
      console.error("[tombstoneGhostMessage] write-through failed", e);
      return {
        ok: false,
        error: e instanceof Error ? e.message : "فشل تنظيف الرسالة العالقة",
        code: "GHOST_CLEANUP_EXCEPTION",
      };
    }
  });
