// Server function that owns one Local Mail Index sync round:
//   Mail Session Token + password  →  DB config  →  Bridge sync  →  DB writes.
//
// Authentication: the caller passes their short-lived signed Mail Session
// Token in the request body. The token is verified with the server-only
// MAIL_SESSION_SECRET (jose HS256). accountId + companyId are read from the
// verified claims — the client cannot forge identity by editing the body.
//
// Concurrency: an atomic advisory-style lock in mail_sync_state prevents two
// syncs from racing on the same (account, folder).
//
// This module is client-safe by construction: every server-only import lives
// inside the handler, so the module can sit on the client bundle graph
// without leaking the service-role client or JWT secret.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AccountShape = z.object({
  email_address: z.string().email().max(320),
  display_name: z.string().nullable().optional(),
  imap_host: z.string().min(1).max(255),
  imap_port: z.number().int().positive().max(65535),
  imap_secure: z.boolean(),
  smtp_host: z.string().min(1).max(255),
  smtp_port: z.number().int().positive().max(65535),
  smtp_secure: z.boolean(),
});

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    password: z.string().min(1).max(1024),
    folderPath: z.string().min(1).max(500).default("INBOX"),
    canonical: z.string().min(1).max(32).optional(),
    mode: z.enum(["initial", "incremental", "reconcile"]),
    limit: z.number().int().positive().max(300).optional(),
    // reconcile-only
    fromUid: z.number().int().positive().optional(),
    toUid: z.number().int().positive().optional(),
    // incremental-only flag delta window (overrides state-derived range)
    flagsFromUid: z.number().int().positive().optional(),
    flagsToUid: z.number().int().positive().optional(),
  })
  .strict();

export type RunMailSyncInput = z.input<typeof InputSchema>;

export type RunMailSyncResult =
  | {
      ok: true;
      busy: false;
      mode: "initial" | "incremental" | "reconcile";
      folderId: string;
      folderPath: string;
      wroteMessages: number;
      appliedFlagChanges: number;
      tombstoned: number;
      wipedForUidValidity: boolean;
      total: number;
      unread: number;
      uidvalidity: string;
      newestSyncedUid: number | null;
      oldestSyncedUid: number | null;
      hasMore: boolean;
      flagsSync: "condstore" | "reconcile-required" | "not-requested";
    }
  | { ok: true; busy: true; reason: "LOCKED" }
  | { ok: false; error: string; code: string };

const BRIDGE_TTL_SECONDS = 60;

async function bridgePost(path: string, payload: unknown) {
  const url = process.env.MAIL_BRIDGE_URL;
  const key = process.env.MAIL_BRIDGE_SECRET;
  if (!url || !key) throw new Error("BRIDGE_NOT_CONFIGURED");
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Key": key,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const errCode = (json.error as string) || `BRIDGE_HTTP_${res.status}`;
    throw new Error(errCode);
  }
  return json;
}

export const runMailSync = createServerFn({ method: "POST" })
  .inputValidator((input: RunMailSyncInput) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<RunMailSyncResult> => {
    // ---- server-only imports (kept out of the client bundle) ----
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const {
      resolveMailConfigForAccount,
      MailAccountNotFoundError,
      MailAccountCompanyMismatchError,
      MailConfigIncompleteError,
    } = await import("@/lib/mail-config.server");
    const {
      ensureFolderRow,
      wipeFolderForUidValidityReset,
      upsertMessagesInBatches,
      applyFlagStates,
      tombstoneMissingInRange,
      refreshFolderCounts,
      writeFolderMailboxState,
      updateSyncCursor,
      readSyncCursor,
      claimSyncLock,
      releaseSyncLock,
      shouldWipeForUidValidity,
    } = await import("@/lib/mail-sync-writer.server");

    // ---- 1) Verify token ----
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }
    const accountId = claims.sub;
    const companyId = claims.cid;

    // ---- 2) Resolve config ----
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
      console.error("[runMailSync] resolveConfig failed", e);
      return { ok: false, error: "تعذر تحميل إعدادات البريد.", code: "CONFIG_LOAD_FAILED" };
    }

    const bridgeAccount = AccountShape.parse({
      email_address: cfg.emailAddress,
      display_name: cfg.displayName,
      imap_host: cfg.imapHost,
      imap_port: cfg.imapPort,
      imap_secure: cfg.imapSecure,
      smtp_host: cfg.smtpHost,
      smtp_port: cfg.smtpPort,
      smtp_secure: cfg.smtpSecure,
    });

    // ---- 3) Folder + lock ----
    const { folderId, storedUidValidity } = await ensureFolderRow(supabaseAdmin, {
      accountId,
      companyId,
      path: data.folderPath,
      canonical: data.canonical ?? null,
    });

    const lockedBy = `sync:${crypto.randomUUID()}`;
    const claimed = await claimSyncLock(supabaseAdmin, {
      accountId,
      companyId,
      folderId,
      lockedBy,
      ttlSeconds: BRIDGE_TTL_SECONDS,
    });
    if (!claimed) return { ok: true, busy: true, reason: "LOCKED" };

    let releaseStatus: "idle" | "error" = "idle";
    let releaseErrCode: string | null = null;
    let releaseErrMsg: string | null = null;

    try {
      // ---- 4) Dispatch to bridge ----
      const cursor = await readSyncCursor(supabaseAdmin, { accountId, folderId });
      let wipedForUidValidity = false;
      let wroteMessages = 0;
      let appliedFlagChanges = 0;
      let tombstoned = 0;
      let hasMore = false;
      let flagsSync: "condstore" | "reconcile-required" | "not-requested" = "not-requested";
      let mailboxUidValidity: string;
      let mailboxUidNext: number | null = null;
      let mailboxHighestModseq: string | null = null;
      let mailboxExists = 0;

      if (data.mode === "initial") {
        const result = (await bridgePost("/api/sync/initial", {
          account: bridgeAccount,
          password: data.password,
          folderPath: data.folderPath,
          limit: data.limit ?? 300,
        })) as {
          mailbox: {
            path: string;
            exists: number;
            uidValidity: string;
            uidNext: number | null;
            highestModseq: string | null;
          };
          messages: Array<Parameters<typeof upsertMessagesInBatches>[2][number]>;
          oldestReturnedUid: number | null;
          newestReturnedUid: number | null;
        };
        mailboxUidValidity = result.mailbox.uidValidity;
        mailboxUidNext = result.mailbox.uidNext;
        mailboxHighestModseq = result.mailbox.highestModseq;
        mailboxExists = result.mailbox.exists;

        if (shouldWipeForUidValidity(storedUidValidity, mailboxUidValidity)) {
          await wipeFolderForUidValidityReset(supabaseAdmin, {
            accountId,
            companyId,
            folderId,
            newUidValidity: mailboxUidValidity,
          });
          wipedForUidValidity = true;
        }

        wroteMessages = await upsertMessagesInBatches(
          supabaseAdmin,
          { accountId, companyId, folderId, uidValidity: mailboxUidValidity },
          result.messages,
        );

        await updateSyncCursor(supabaseAdmin, {
          accountId,
          folderId,
          uidValidity: mailboxUidValidity,
          uidNext: mailboxUidNext,
          highestModseq: mailboxHighestModseq,
          oldestSyncedUid: result.oldestReturnedUid,
          newestSyncedUid: result.newestReturnedUid,
          flagsNeedReconcile: false,
        });
      } else if (data.mode === "incremental") {
        if (!cursor || cursor.newest_synced_uid == null || cursor.uidvalidity == null) {
          return {
            ok: false,
            error: "لم يتم إجراء مزامنة أولية بعد.",
            code: "NO_CURSOR",
          };
        }

        // Optional flag-delta window: use caller override, else last 500 UIDs.
        const flagsFrom = data.flagsFromUid ?? Math.max(1, cursor.newest_synced_uid - 500);
        const flagsTo = data.flagsToUid ?? cursor.newest_synced_uid;

        const result = (await bridgePost("/api/sync/incremental", {
          account: bridgeAccount,
          password: data.password,
          folderPath: data.folderPath,
          expectedUidValidity: cursor.uidvalidity,
          sinceUid: cursor.newest_synced_uid,
          sinceModseq: cursor.highest_modseq ?? undefined,
          flagsFromUid: flagsFrom,
          flagsToUid: flagsTo,
          limit: data.limit ?? 300,
        })) as {
          mailbox: {
            path: string;
            exists: number;
            uidValidity: string;
            uidNext: number | null;
            highestModseq: string | null;
          };
          resetRequired: boolean;
          reason?: string;
          newMessages?: Array<Parameters<typeof upsertMessagesInBatches>[2][number]>;
          nextSinceUid?: number;
          hasMore?: boolean;
          flagsSync?: "condstore" | "reconcile-required" | "not-requested";
          flagChanges?: Array<Parameters<typeof applyFlagStates>[2][number]>;
        };
        mailboxUidValidity = result.mailbox.uidValidity;
        mailboxUidNext = result.mailbox.uidNext;
        mailboxHighestModseq = result.mailbox.highestModseq;
        mailboxExists = result.mailbox.exists;

        if (result.resetRequired) {
          await wipeFolderForUidValidityReset(supabaseAdmin, {
            accountId,
            companyId,
            folderId,
            newUidValidity: mailboxUidValidity,
          });
          wipedForUidValidity = true;
          await updateSyncCursor(supabaseAdmin, {
            accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            uidNext: mailboxUidNext,
            highestModseq: mailboxHighestModseq,
            oldestSyncedUid: null,
            newestSyncedUid: null,
            flagsNeedReconcile: false,
          });
        } else {
          const messages = result.newMessages ?? [];
          wroteMessages = await upsertMessagesInBatches(
            supabaseAdmin,
            { accountId, companyId, folderId, uidValidity: mailboxUidValidity },
            messages,
          );
          appliedFlagChanges = await applyFlagStates(
            supabaseAdmin,
            { accountId, folderId, uidValidity: mailboxUidValidity },
            result.flagChanges ?? [],
          );
          hasMore = !!result.hasMore;
          flagsSync = result.flagsSync ?? "not-requested";

          const newestFromBatch = messages.length ? messages[messages.length - 1].uid : null;
          const nextNewest = Math.max(
            cursor.newest_synced_uid ?? 0,
            result.nextSinceUid ?? 0,
            newestFromBatch ?? 0,
          );
          await updateSyncCursor(supabaseAdmin, {
            accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            uidNext: mailboxUidNext,
            highestModseq: mailboxHighestModseq,
            oldestSyncedUid: cursor.oldest_synced_uid,
            newestSyncedUid: nextNewest > 0 ? nextNewest : null,
            flagsNeedReconcile: flagsSync === "reconcile-required" ? true : null,
          });
        }
      } else {
        // reconcile
        if (!cursor || cursor.uidvalidity == null) {
          return {
            ok: false,
            error: "لا توجد حالة مزامنة سابقة لهذا المجلد.",
            code: "NO_CURSOR",
          };
        }
        const RECONCILE_MAX_RANGE = 1000; // matches bridge's V1_MAX_RECONCILE_RANGE
        const requestedFrom = data.fromUid ?? cursor.oldest_synced_uid ?? 1;
        const requestedTo = data.toUid ?? cursor.newest_synced_uid ?? requestedFrom;
        // Auto-bound to the newest window so a large synced range never
        // trips the bridge's max-range guard. Reconciling the most recent
        // slice is enough to catch flag drift + tombstones in practice.
        const toUid = requestedTo;
        const fromUid = Math.max(requestedFrom, toUid - (RECONCILE_MAX_RANGE - 1));
        if (toUid < fromUid) {
          return { ok: false, error: "نطاق التوفيق غير صالح.", code: "INVALID_RANGE" };
        }


        const result = (await bridgePost("/api/sync/reconcile", {
          account: bridgeAccount,
          password: data.password,
          folderPath: data.folderPath,
          expectedUidValidity: cursor.uidvalidity,
          fromUid,
          toUid,
        })) as {
          mailbox: {
            path: string;
            exists: number;
            uidValidity: string;
            uidNext: number | null;
            highestModseq: string | null;
          };
          resetRequired: boolean;
          states?: Array<Parameters<typeof applyFlagStates>[2][number]>;
        };
        mailboxUidValidity = result.mailbox.uidValidity;
        mailboxUidNext = result.mailbox.uidNext;
        mailboxHighestModseq = result.mailbox.highestModseq;
        mailboxExists = result.mailbox.exists;

        if (result.resetRequired) {
          await wipeFolderForUidValidityReset(supabaseAdmin, {
            accountId,
            companyId,
            folderId,
            newUidValidity: mailboxUidValidity,
          });
          wipedForUidValidity = true;
          await updateSyncCursor(supabaseAdmin, {
            accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            uidNext: mailboxUidNext,
            highestModseq: mailboxHighestModseq,
            oldestSyncedUid: null,
            newestSyncedUid: null,
            flagsNeedReconcile: false,
          });
        } else {
          const states = result.states ?? [];
          appliedFlagChanges = await applyFlagStates(
            supabaseAdmin,
            { accountId, folderId, uidValidity: mailboxUidValidity },
            states,
          );
          tombstoned = await tombstoneMissingInRange(supabaseAdmin, {
            accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            fromUid,
            toUid,
            presentUids: states.map((s) => s.uid),
          });
          await updateSyncCursor(supabaseAdmin, {
            accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            uidNext: mailboxUidNext,
            highestModseq: mailboxHighestModseq,
            oldestSyncedUid: cursor.oldest_synced_uid,
            newestSyncedUid: cursor.newest_synced_uid,
            flagsNeedReconcile: false,
            markReconciledAt: true,
          });
        }
      }

      // Persist mailbox-level state on the folder row and refresh counts.
      await writeFolderMailboxState(supabaseAdmin, folderId, {
        path: data.folderPath,
        exists: mailboxExists,
        uidValidity: mailboxUidValidity,
        uidNext: mailboxUidNext,
        highestModseq: mailboxHighestModseq,
      });
      const counts = await refreshFolderCounts(supabaseAdmin, {
        accountId,
        folderId,
        uidValidity: mailboxUidValidity,
      });

      // Read the final cursor so the response reflects what got persisted.
      const finalCursor = await readSyncCursor(supabaseAdmin, { accountId, folderId });

      return {
        ok: true,
        busy: false,
        mode: data.mode,
        folderId,
        folderPath: data.folderPath,
        wroteMessages,
        appliedFlagChanges,
        tombstoned,
        wipedForUidValidity,
        total: counts.total,
        unread: counts.unread,
        uidvalidity: mailboxUidValidity,
        newestSyncedUid: finalCursor?.newest_synced_uid ?? null,
        oldestSyncedUid: finalCursor?.oldest_synced_uid ?? null,
        hasMore,
        flagsSync,
      };
    } catch (err) {
      releaseStatus = "error";
      const raw = err instanceof Error ? err.message : String(err ?? "");
      releaseErrCode = /^[A-Z0-9_]+$/.test(raw) ? raw : "SYNC_FAILED";
      releaseErrMsg = raw.slice(0, 300);
      console.error("[runMailSync] sync failed", releaseErrCode);
      return { ok: false, error: "فشل تشغيل المزامنة.", code: releaseErrCode };
    } finally {
      try {
        await releaseSyncLock(supabaseAdmin, {
          accountId,
          companyId,
          folderId,
          lockedBy,
          status: releaseStatus,
          errorCode: releaseErrCode,
          errorMessage: releaseErrMsg,
        });
      } catch (releaseErr) {
        console.error("[runMailSync] release lock failed", releaseErr);
      }
    }
  });
