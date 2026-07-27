// Atomic Move server function. After verifying the Mail Session JWT, this
// orchestrates one Bridge move + Local Mail Index write-through + targeted
// destination and source syncs (Blocker 2: BLOCKER_2_TARGETED_SYNC).
//
// Auth model (identical to indexUpdateFlag): accountId/companyId come from
// verified JWT claims, never from client input. The bridge is called
// exactly once per invocation. A DB/sync failure NEVER rolls the UI back —
// IMAP is the source of truth.
//
// The orchestration logic lives in `mail-move-orchestration.ts` (pure,
// dependency-injected, unit-tested). This module wires the real server-
// only dependencies inside the handler so it stays client-safe.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  moveMessageOrchestration,
  type MoveOrchestrationDeps,
  type MoveOrchestrationResult,
  type BridgeMoveInfo,
} from "@/lib/mail-move-orchestration";

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

// Re-export orchestration types so UI code has a single source of truth.
export type IndexMoveMoveInfo = BridgeMoveInfo;
export type IndexMoveResult = MoveOrchestrationResult;

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
    const {
      applyMoveWriteThrough,
      resolveFolderByCanonical,
      captureSourceFingerprint,
      discoverDestinationUid,
      normalizeCanonicalForIndex,
    } = await import("@/lib/mail-move-writer.server");
    const { readSyncCursor } = await import("@/lib/mail-sync-writer.server");
    const { runMailSyncCore } = await import("@/lib/mail-sync-runner.server");

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

    const bridgeAccount = {
      email_address: cfg.emailAddress,
      display_name: cfg.displayName,
      imap_host: cfg.imapHost,
      imap_port: cfg.imapPort,
      imap_secure: cfg.imapSecure,
      smtp_host: cfg.smtpHost,
      smtp_port: cfg.smtpPort,
      smtp_secure: cfg.smtpSecure,
    };

    // 3) Env preflight — required to reach the Bridge at all.
    const url = process.env.MAIL_BRIDGE_URL;
    const key = process.env.MAIL_BRIDGE_SECRET;
    if (!url || !key) {
      return { ok: false, error: "لم يتم ربط خادم البريد.", code: "BRIDGE_NOT_CONFIGURED" };
    }

    // 4) Wire real deps into the orchestration core.
    const physicalSourceCanonical = normalizeCanonicalForIndex(data.sourceCanonical);
    const physicalDestCanonical = normalizeCanonicalForIndex(data.destCanonical);

    const deps: MoveOrchestrationDeps = {
      loadSource: async () => {
        const folder = await resolveFolderByCanonical(
          supabaseAdmin,
          accountId,
          companyId,
          data.sourceCanonical,
        );
        if (!folder || folder.uidvalidity == null || !folder.path) return null;
        const [cursor, fingerprint] = await Promise.all([
          readSyncCursor(supabaseAdmin, { accountId, folderId: folder.id }),
          captureSourceFingerprint(supabaseAdmin, {
            accountId,
            folderId: folder.id,
            uidvalidity: folder.uidvalidity,
            uid: data.uid,
          }),
        ]);
        return {
          folderId: folder.id,
          uidvalidity: folder.uidvalidity,
          path: folder.path,
          canonical: physicalSourceCanonical,
          cursorNewestSyncedUid: cursor?.newest_synced_uid ?? null,
          fingerprint,
        };
      },
      loadDest: async () => {
        const folder = await resolveFolderByCanonical(
          supabaseAdmin,
          accountId,
          companyId,
          data.destCanonical,
        );
        if (!folder) return { folder: null, cursorNewestSyncedUid: null };
        const cursor = await readSyncCursor(supabaseAdmin, {
          accountId,
          folderId: folder.id,
        });
        return {
          folder: { id: folder.id, uidvalidity: folder.uidvalidity, path: folder.path },
          cursorNewestSyncedUid: cursor?.newest_synced_uid ?? null,
        };
      },
      bridgeMove: async () => {
        try {
          const res = await fetch(`${url.replace(/\/$/, "")}/api/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
            body: JSON.stringify({
              account: bridgeAccount,
              password: data.password,
              folder: data.sourceCanonical,
              uid: data.uid,
              toFolder: data.destCanonical,
            }),
          });
          const text = await res.text();
          let json: { ok?: boolean; error?: string; move?: BridgeMoveInfo } = {};
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          if (!res.ok || !json.ok) {
            return {
              ok: false,
              error: json.error || `Bridge error ${res.status}`,
              code: "BRIDGE_MOVE_FAILED",
            };
          }
          return {
            ok: true,
            move: json.move ?? { sourceUid: data.uid, uidMappingAvailable: false },
          };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Bridge unreachable",
            code: "BRIDGE_UNREACHABLE",
          };
        }
      },
      applyWriteThrough: async (move) => {
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
          if (!outcome.ok) return { ok: false, error: outcome.error };
          return {
            ok: true,
            applied: outcome.applied === "no-source-folder" ? "no-source-folder" : outcome.applied,
            sourceTombstoned: outcome.sourceTombstoned,
            destinationInserted: outcome.destinationInserted,
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      runDestSync: async ({ folderPath, canonical, mode }) => {
        const res = await runMailSyncCore(supabaseAdmin, {
          accountId,
          companyId,
          bridgeAccount,
          password: data.password,
          folderPath,
          canonical,
          mode,
          limit: mode === "initial" ? 300 : 300,
        });
        if (!res.ok) return { ok: false, error: res.error, code: res.code };
        if (res.busy) return { ok: true, busy: true };
        return { ok: true, busy: false, hasMore: res.hasMore };
      },
      reloadDest: async () => {
        const folder = await resolveFolderByCanonical(
          supabaseAdmin,
          accountId,
          companyId,
          data.destCanonical,
        );
        if (!folder) return { folder: null, cursorNewestSyncedUid: null };
        const cursor = await readSyncCursor(supabaseAdmin, {
          accountId,
          folderId: folder.id,
        });
        return {
          folder: { id: folder.id, uidvalidity: folder.uidvalidity, path: folder.path },
          cursorNewestSyncedUid: cursor?.newest_synced_uid ?? null,
        };
      },
      discoverDest: (params) =>
        discoverDestinationUid(supabaseAdmin, {
          accountId,
          folderId: params.folderId,
          uidvalidity: params.uidvalidity,
          cutoffUid: params.cutoffUid,
          fingerprint: params.fingerprint,
        }),
      runSourceReconcile: async ({ folderPath, canonical, uid }) => {
        const res = await runMailSyncCore(supabaseAdmin, {
          accountId,
          companyId,
          bridgeAccount,
          password: data.password,
          folderPath,
          canonical,
          mode: "reconcile",
          fromUid: uid,
          toUid: uid,
        });
        if (!res.ok) return { ok: false, error: res.error, code: res.code };
        if (res.busy) return { ok: true, busy: true };
        // 1-UID reconcile MUST produce a presence signal derived from IMAP
        // (Bridge). If the runner returned no signal for any reason, treat
        // it as "still-present" — the orchestrator will downgrade the
        // result to `partial` rather than falsely claim absence.
        const targetUidPresent = res.singleUidPresence
          ? res.singleUidPresence.present
          : true;
        return { ok: true, busy: false, targetUidPresent };
      },

      logError: (label, err) => {
        // Safe: never logs password or secrets.
        console.error(label, err instanceof Error ? err.message : String(err));
      },
    };

    return moveMessageOrchestration(deps, {
      sourceCanonical: data.sourceCanonical,
      destCanonical: data.destCanonical,
      sourceUid: data.uid,
    });
  });
