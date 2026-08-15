// Server-only: reusable Local Mail Index sync engine.
//
// Extracted from `runMailSync` so the same code path drives:
//   * the client-facing `runMailSync` server function, and
//   * the targeted destination/source sync inside `indexMoveMessage`
//     (Blocker 2: BLOCKER_2_TARGETED_SYNC).
//
// Behavior is byte-identical to the previous handler body: same
// ensureFolderRow, sync lock, initial / incremental / reconcile branches,
// UIDVALIDITY reset, upsert / flag / tombstone writes, cursor update,
// mailbox state write, counts refresh, and lock release in `finally`.
//
// Never import from a client bundle: this file's name matches the
// `.server.ts` client-import guard.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ensureFolderRow,
  wipeFolderForUidValidityReset,
  upsertMessagesInBatches,
  applyFlagStates,
  tombstoneMissingInRange,
  tombstoneRowsByUid,
  refreshFolderCounts,
  writeFolderMailboxState,
  updateSyncCursor,
  readSyncCursor,
  claimSyncLock,
  releaseSyncLock,
  shouldWipeForUidValidity,
} from "./mail-sync-writer.server";

export interface CoreBridgeAccount {
  email_address: string;
  display_name?: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
}

export interface RunMailSyncCoreInput {
  accountId: string;
  companyId: string;
  bridgeAccount: CoreBridgeAccount;
  password: string;
  folderPath: string;
  canonical?: string | null;
  mode: "initial" | "incremental" | "reconcile";
  limit?: number;
  fromUid?: number;
  toUid?: number;
  flagsFromUid?: number;
  flagsToUid?: number;
  /**
   * When true, `canonical` is authoritative and `ensureFolderRow` may repair a
   * stale/wrong canonical on the existing physical-path row. Callers that pair a
   * bridge-resolved path with a validated logical canonical set this to true;
   * callers whose path is not fully trusted (move destination, worker) leave it
   * false so an existing canonical is never stolen.
   */
  trustedCanonical?: boolean;
}

export type RunMailSyncCoreResult =
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
      /**
       * Only set for `mode:"reconcile"` with `fromUid === toUid`. Derived
       * from the Bridge's IMAP `states` array (source of truth), NOT from
       * the Local Index — the row may have been Tombstoned prior to the
       * call and would falsely read "absent".
       */
      singleUidPresence?: { uid: number; present: boolean };
    }
  | { ok: true; busy: true; reason: "LOCKED" }
  | { ok: false; error: string; code: string };


const BRIDGE_TTL_SECONDS = 60;

/**
 * Pure helper — extracted so we can unit-test the reconcile presence
 * derivation without wiring a full Bridge + DB fake. Returns `undefined`
 * when the range is not a 1-UID reconcile (contract: only 1-UID reconcile
 * yields a `singleUidPresence`).
 */
export function derivePresenceForSingleUidReconcile(
  fromUid: number,
  toUid: number,
  states: ReadonlyArray<{ uid: number }>,
): { uid: number; present: boolean } | undefined {
  if (fromUid !== toUid) return undefined;
  return { uid: fromUid, present: states.some((s) => s.uid === fromUid) };
}


export type BridgePost = (path: string, payload: unknown) => Promise<Record<string, unknown>>;

async function defaultBridgePost(path: string, payload: unknown): Promise<Record<string, unknown>> {
  const url = process.env.MAIL_BRIDGE_URL;
  const key = process.env.MAIL_BRIDGE_SECRET;
  if (!url || !key) throw new Error("BRIDGE_NOT_CONFIGURED");
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
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

/**
 * Core sync engine. Callers are expected to have already resolved the
 * mail-account config and (in the client-facing path) verified the mail
 * session token. `bridgePost` is injectable to keep the engine testable
 * without a live Bridge; production callers pass no override.
 */
export async function runMailSyncCore(
  admin: SupabaseClient,
  input: RunMailSyncCoreInput,
  bridgePost: BridgePost = defaultBridgePost,
): Promise<RunMailSyncCoreResult> {
  const { folderId, storedUidValidity } = await ensureFolderRow(admin, {
    accountId: input.accountId,
    companyId: input.companyId,
    path: input.folderPath,
    canonical: input.canonical ?? null,
    trustedCanonical: input.trustedCanonical === true,
  });

  // Drafts must never import soft-deleted (\Deleted) copies; exclude them from
  // upsert/flag application and tombstone any already-indexed draft that
  // became \Deleted during reconcile. Non-Draft folders are untouched.
  const isDrafts = input.canonical === "drafts";

  const lockedBy = `sync:${crypto.randomUUID()}`;
  const claimed = await claimSyncLock(admin, {
    accountId: input.accountId,
    companyId: input.companyId,
    folderId,
    lockedBy,
    ttlSeconds: BRIDGE_TTL_SECONDS,
  });
  if (!claimed) return { ok: true, busy: true, reason: "LOCKED" };

  let releaseStatus: "idle" | "error" = "idle";
  let releaseErrCode: string | null = null;
  let releaseErrMsg: string | null = null;

  try {
    const cursor = await readSyncCursor(admin, {
      accountId: input.accountId,
      folderId,
    });
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
    let mailboxLiveTotal: number | null = null;
    let singleUidPresence: { uid: number; present: boolean } | undefined;


    if (input.mode === "initial") {
      const result = (await bridgePost("/api/sync/initial", {
        account: input.bridgeAccount,
        password: input.password,
        folderPath: input.folderPath,
        limit: input.limit ?? 300,
        countExcludeDeleted: isDrafts,
      })) as {
        mailbox: {
          path: string;
          exists: number;
          uidValidity: string;
          uidNext: number | null;
          highestModseq: string | null;
          liveTotal: number | null;
        };
        messages: Array<Parameters<typeof upsertMessagesInBatches>[2][number]>;
        oldestReturnedUid: number | null;
        newestReturnedUid: number | null;
      };
      mailboxUidValidity = result.mailbox.uidValidity;
      mailboxUidNext = result.mailbox.uidNext;
      mailboxHighestModseq = result.mailbox.highestModseq;
      mailboxExists = result.mailbox.exists;
      mailboxLiveTotal = result.mailbox.liveTotal ?? null;

      if (shouldWipeForUidValidity(storedUidValidity, mailboxUidValidity)) {
        await wipeFolderForUidValidityReset(admin, {
          accountId: input.accountId,
          companyId: input.companyId,
          folderId,
          newUidValidity: mailboxUidValidity,
        });
        wipedForUidValidity = true;
      }

      const initialMessages = isDrafts
        ? result.messages.filter((m) => !m.flagDeleted)
        : result.messages;
      wroteMessages = await upsertMessagesInBatches(
        admin,
        {
          accountId: input.accountId,
          companyId: input.companyId,
          folderId,
          uidValidity: mailboxUidValidity,
        },
        initialMessages,
      );

      await updateSyncCursor(admin, {
        accountId: input.accountId,
        folderId,
        uidValidity: mailboxUidValidity,
        uidNext: mailboxUidNext,
        highestModseq: mailboxHighestModseq,
        oldestSyncedUid: result.oldestReturnedUid,
        newestSyncedUid: result.newestReturnedUid,
        flagsNeedReconcile: false,
      });
    } else if (input.mode === "incremental") {
      if (!cursor || cursor.newest_synced_uid == null || cursor.uidvalidity == null) {
        return { ok: false, error: "لم يتم إجراء مزامنة أولية بعد.", code: "NO_CURSOR" };
      }

      const flagsFrom = input.flagsFromUid ?? Math.max(1, cursor.newest_synced_uid - 500);
      const flagsTo = input.flagsToUid ?? cursor.newest_synced_uid;

      const result = (await bridgePost("/api/sync/incremental", {
        account: input.bridgeAccount,
        password: input.password,
        folderPath: input.folderPath,
        expectedUidValidity: cursor.uidvalidity,
        sinceUid: cursor.newest_synced_uid,
        sinceModseq: cursor.highest_modseq ?? undefined,
        flagsFromUid: flagsFrom,
        flagsToUid: flagsTo,
        limit: input.limit ?? 300,
        countExcludeDeleted: isDrafts,
      })) as {
        mailbox: {
          path: string;
          exists: number;
          uidValidity: string;
          uidNext: number | null;
          highestModseq: string | null;
          liveTotal: number | null;
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
      mailboxLiveTotal = result.mailbox.liveTotal ?? null;

      if (result.resetRequired) {
        await wipeFolderForUidValidityReset(admin, {
          accountId: input.accountId,
          companyId: input.companyId,
          folderId,
          newUidValidity: mailboxUidValidity,
        });
        wipedForUidValidity = true;
        await updateSyncCursor(admin, {
          accountId: input.accountId,
          folderId,
          uidValidity: mailboxUidValidity,
          uidNext: mailboxUidNext,
          highestModseq: mailboxHighestModseq,
          oldestSyncedUid: null,
          newestSyncedUid: null,
          flagsNeedReconcile: false,
        });
      } else {
        const rawMessages = result.newMessages ?? [];
        const messages = isDrafts ? rawMessages.filter((m) => !m.flagDeleted) : rawMessages;
        wroteMessages = await upsertMessagesInBatches(
          admin,
          {
            accountId: input.accountId,
            companyId: input.companyId,
            folderId,
            uidValidity: mailboxUidValidity,
          },
          messages,
        );
        const rawFlagChanges = result.flagChanges ?? [];
        if (isDrafts) {
          // \Deleted flag states must tombstone, not apply as live flag changes.
          const deletedUids = rawFlagChanges.filter((f) => f.flagDeleted).map((f) => f.uid);
          const liveChanges = rawFlagChanges.filter((f) => !f.flagDeleted);
          appliedFlagChanges = await applyFlagStates(
            admin,
            { accountId: input.accountId, folderId, uidValidity: mailboxUidValidity },
            liveChanges,
          );
          if (deletedUids.length) {
            await tombstoneRowsByUid(admin, {
              accountId: input.accountId,
              folderId,
              uidValidity: mailboxUidValidity,
              uids: deletedUids,
            });
          }
        } else {
          appliedFlagChanges = await applyFlagStates(
            admin,
            { accountId: input.accountId, folderId, uidValidity: mailboxUidValidity },
            rawFlagChanges,
          );
        }
        hasMore = !!result.hasMore;
        flagsSync = result.flagsSync ?? "not-requested";

        const newestFromBatch = messages.length ? messages[messages.length - 1].uid : null;
        const nextNewest = Math.max(
          cursor.newest_synced_uid ?? 0,
          result.nextSinceUid ?? 0,
          newestFromBatch ?? 0,
        );
        await updateSyncCursor(admin, {
          accountId: input.accountId,
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
      const RECONCILE_MAX_RANGE = 1000;
      const requestedFrom = input.fromUid ?? cursor.oldest_synced_uid ?? 1;
      const requestedTo = input.toUid ?? cursor.newest_synced_uid ?? requestedFrom;
      const toUid = requestedTo;
      const fromUid = Math.max(requestedFrom, toUid - (RECONCILE_MAX_RANGE - 1));
      if (toUid < fromUid) {
        return { ok: false, error: "نطاق التوفيق غير صالح.", code: "INVALID_RANGE" };
      }

      const result = (await bridgePost("/api/sync/reconcile", {
        account: input.bridgeAccount,
        password: input.password,
        folderPath: input.folderPath,
        expectedUidValidity: cursor.uidvalidity,
        fromUid,
        toUid,
        countExcludeDeleted: isDrafts,
      })) as {
        mailbox: {
          path: string;
          exists: number;
          uidValidity: string;
          uidNext: number | null;
          highestModseq: string | null;
          liveTotal: number | null;
        };
        resetRequired: boolean;
        states?: Array<Parameters<typeof applyFlagStates>[2][number]>;
      };
      mailboxUidValidity = result.mailbox.uidValidity;
      mailboxUidNext = result.mailbox.uidNext;
      mailboxHighestModseq = result.mailbox.highestModseq;
      mailboxExists = result.mailbox.exists;
      mailboxLiveTotal = result.mailbox.liveTotal ?? null;

      if (result.resetRequired) {
        await wipeFolderForUidValidityReset(admin, {
          accountId: input.accountId,
          companyId: input.companyId,
          folderId,
          newUidValidity: mailboxUidValidity,
        });
        wipedForUidValidity = true;
        await updateSyncCursor(admin, {
          accountId: input.accountId,
          folderId,
          uidValidity: mailboxUidValidity,
          uidNext: mailboxUidNext,
          highestModseq: mailboxHighestModseq,
          oldestSyncedUid: null,
          newestSyncedUid: null,
          flagsNeedReconcile: false,
        });
      } else {
        const rawStates = result.states ?? [];
        if (isDrafts) {
          // \Deleted drafts are "absent" for reconcile: tombstone them, then
          // reconcile the live remainder normally.
          const deletedUids = rawStates.filter((s) => s.flagDeleted).map((s) => s.uid);
          const liveStates = rawStates.filter((s) => !s.flagDeleted);
          if (deletedUids.length) {
            await tombstoneRowsByUid(admin, {
              accountId: input.accountId,
              folderId,
              uidValidity: mailboxUidValidity,
              uids: deletedUids,
            });
          }
          appliedFlagChanges = await applyFlagStates(
            admin,
            { accountId: input.accountId, folderId, uidValidity: mailboxUidValidity },
            liveStates,
          );
          tombstoned = await tombstoneMissingInRange(admin, {
            accountId: input.accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            fromUid,
            toUid,
            presentUids: liveStates.map((s) => s.uid),
          });
          singleUidPresence = derivePresenceForSingleUidReconcile(fromUid, toUid, liveStates);
        } else {
          const states = rawStates;
          appliedFlagChanges = await applyFlagStates(
            admin,
            { accountId: input.accountId, folderId, uidValidity: mailboxUidValidity },
            states,
          );
          tombstoned = await tombstoneMissingInRange(admin, {
            accountId: input.accountId,
            folderId,
            uidValidity: mailboxUidValidity,
            fromUid,
            toUid,
            presentUids: states.map((s) => s.uid),
          });
          // 1-UID reconcile: derive presence from the Bridge/IMAP response
          // directly. This is the ONLY authoritative signal for the Move
          // source-confirmation contract (Local Index is already Tombstoned).
          singleUidPresence = derivePresenceForSingleUidReconcile(fromUid, toUid, states);
        }

        await updateSyncCursor(admin, {
          accountId: input.accountId,
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

    await writeFolderMailboxState(admin, folderId, {
      path: input.folderPath,
      exists: mailboxExists,
      uidValidity: mailboxUidValidity,
      uidNext: mailboxUidNext,
      highestModseq: mailboxHighestModseq,
    });
    const counts = await refreshFolderCounts(admin, {
      accountId: input.accountId,
      folderId,
      uidValidity: mailboxUidValidity,
      // Blocker 2 — pass the IMAP-authoritative EXISTS captured from the
      // sync's mailbox status so the folder total reflects the real mailbox
      // size, not just the locally-indexed page (max 300). Drafts are the
      // exception: EXISTS counts \Deleted (soft-deleted) copies, so Drafts use
      // the sync-provided authoritative UNDELETED live count instead.
      authoritativeTotal: isDrafts ? mailboxLiveTotal : mailboxExists,
    });


    const finalCursor = await readSyncCursor(admin, {
      accountId: input.accountId,
      folderId,
    });

    return {
      ok: true,
      busy: false,
      mode: input.mode,
      folderId,
      folderPath: input.folderPath,
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
      ...(singleUidPresence ? { singleUidPresence } : {}),
    };

  } catch (err) {
    releaseStatus = "error";
    const raw = err instanceof Error ? err.message : String(err ?? "");
    releaseErrCode = /^[A-Z0-9_]+$/.test(raw) ? raw : "SYNC_FAILED";
    releaseErrMsg = raw.slice(0, 300);
    console.error("[runMailSyncCore] sync failed", releaseErrCode);
    return { ok: false, error: "فشل تشغيل المزامنة.", code: releaseErrCode };
  } finally {
    try {
      await releaseSyncLock(admin, {
        accountId: input.accountId,
        companyId: input.companyId,
        folderId,
        lockedBy,
        status: releaseStatus,
        errorCode: releaseErrCode,
        errorMessage: releaseErrMsg,
      });
    } catch (releaseErr) {
      console.error("[runMailSyncCore] release lock failed", releaseErr);
    }
  }
}
