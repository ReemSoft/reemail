// Server-only. Writer helpers for the Local Mail Index. Never import from
// the client bundle. All state-changing operations go through supabaseAdmin.
//
// Pure helpers (mapSyncMessageToRow, mapFlagStateToUpdate,
// computeTombstoneUids, shouldWipeForUidValidity) are exported for unit tests.
import type { supabaseAdmin as SupabaseAdminType } from "@/integrations/supabase/client.server";

type Admin = typeof SupabaseAdminType;

// ---------------- Wire shapes (mirror bridge/src/sync.ts) ----------------

export interface SyncAddress {
  name: string | null;
  email: string;
}

export interface SyncMessagePayload {
  uid: number;
  modseq: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  subject: string;
  from: SyncAddress | null;
  to: SyncAddress[];
  cc: SyncAddress[];
  internalDate: string;
  sizeBytes: number | null;
  hasAttachments: boolean;
  flagSeen: boolean;
  flagFlagged: boolean;
  flagAnswered: boolean;
  flagDraft: boolean;
  keywords: string[];
}

export interface SyncFlagStatePayload {
  uid: number;
  modseq: string | null;
  flagSeen: boolean;
  flagFlagged: boolean;
  flagAnswered: boolean;
  flagDraft: boolean;
  keywords: string[];
}

export interface MailboxStatePayload {
  path: string;
  exists: number;
  uidValidity: string;
  uidNext: number | null;
  highestModseq: string | null;
}

export const UPSERT_CHUNK = 200;

// ==============================================================
// Pure helpers (unit-testable)
// ==============================================================

/**
 * True iff the mailbox's UIDVALIDITY differs from the value we already stored
 * for this folder. First-time sync (`stored == null`) is NOT a wipe — it's
 * the initial adoption of the value.
 */
export function shouldWipeForUidValidity(
  stored: string | null | undefined,
  incoming: string,
): boolean {
  if (stored == null) return false;
  return String(stored) !== String(incoming);
}

/**
 * Given the set of UIDs currently present on the server within [fromUid,toUid]
 * and the set of UIDs we already have locally in the same range, return the
 * UIDs to tombstone (present locally, missing on server).
 */
export function computeTombstoneUids(
  localUids: readonly number[],
  presentUids: readonly number[],
): number[] {
  const present = new Set<number>();
  for (const u of presentUids) present.add(u);
  const out: number[] = [];
  for (const u of localUids) if (!present.has(u)) out.push(u);
  return out;
}

export function mapSyncMessageToRow(
  args: {
    accountId: string;
    companyId: string;
    folderId: string;
    uidValidity: string;
  },
  m: SyncMessagePayload,
) {
  return {
    account_id: args.accountId,
    company_id: args.companyId,
    folder_id: args.folderId,
    uid: m.uid,
    uidvalidity: Number(args.uidValidity),
    modseq: m.modseq == null ? null : Number(m.modseq),
    message_id: m.messageId,
    in_reply_to: m.inReplyTo,
    subject: m.subject && m.subject.length ? m.subject : null,
    from_addr: m.from,
    to_addrs: m.to,
    cc_addrs: m.cc,
    internal_date: m.internalDate,
    size_bytes: m.sizeBytes,
    has_attachments: m.hasAttachments,
    seen: m.flagSeen,
    flagged: m.flagFlagged,
    answered: m.flagAnswered,
    draft: m.flagDraft,
    keywords: m.keywords,
    deleted_at: null as string | null,
  };
}

export function mapFlagStateToUpdate(s: SyncFlagStatePayload) {
  return {
    modseq: s.modseq == null ? null : Number(s.modseq),
    seen: s.flagSeen,
    flagged: s.flagFlagged,
    answered: s.flagAnswered,
    draft: s.flagDraft,
    keywords: s.keywords,
  };
}

// ==============================================================
// DB helpers
// ==============================================================

/**
 * Get or create the folder row for (account_id, path). Returns the folder id
 * plus the currently-stored uidvalidity (if any) so callers can detect a
 * UIDVALIDITY reset without a second round-trip.
 */
export async function ensureFolderRow(
  admin: Admin,
  args: {
    accountId: string;
    companyId: string;
    path: string;
    canonical?: string | null;
    delimiter?: string | null;
    supported?: boolean;
  },
): Promise<{ folderId: string; storedUidValidity: string | null }> {
  const sel = await admin
    .from("mail_folders")
    .select("id, uidvalidity")
    .eq("account_id", args.accountId)
    .eq("path", args.path)
    .maybeSingle();
  if (sel.error) throw sel.error;
  if (sel.data?.id) {
    return {
      folderId: sel.data.id,
      storedUidValidity: sel.data.uidvalidity != null ? String(sel.data.uidvalidity) : null,
    };
  }

  const ins = await admin
    .from("mail_folders")
    .insert({
      account_id: args.accountId,
      company_id: args.companyId,
      path: args.path,
      canonical: args.canonical ?? null,
      delimiter: args.delimiter ?? null,
      supported: args.supported ?? true,
    })
    .select("id, uidvalidity")
    .maybeSingle();

  if (ins.error) {
    // Race: unique(account_id, path) collision, re-read.
    const code = (ins.error as { code?: string }).code;
    if (code === "23505") {
      const again = await admin
        .from("mail_folders")
        .select("id, uidvalidity")
        .eq("account_id", args.accountId)
        .eq("path", args.path)
        .maybeSingle();
      if (again.data?.id) {
        return {
          folderId: again.data.id,
          storedUidValidity: again.data.uidvalidity != null ? String(again.data.uidvalidity) : null,
        };
      }
    }
    throw ins.error;
  }
  if (!ins.data?.id) throw new Error("FOLDER_UPSERT_FAILED");
  return {
    folderId: ins.data.id,
    storedUidValidity: ins.data.uidvalidity != null ? String(ins.data.uidvalidity) : null,
  };
}

/**
 * Wipe all local rows for a folder when UIDVALIDITY changed. The folder row
 * itself is retained; sync_state cursors are reset so the next call behaves
 * like a fresh initial sync.
 */
export async function wipeFolderForUidValidityReset(
  admin: Admin,
  args: {
    accountId: string;
    companyId: string;
    folderId: string;
    newUidValidity: string;
  },
): Promise<void> {
  const del = await admin
    .from("mail_messages")
    .delete()
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId);
  if (del.error) throw del.error;

  const stateUp = await admin
    .from("mail_sync_state")
    .update({
      uidvalidity: Number(args.newUidValidity),
      oldest_synced_uid: null,
      newest_synced_uid: null,
      highest_modseq: null,
      uidnext: null,
      flags_need_reconcile: false,
      last_reconcile_at: null,
    })
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId);
  if (stateUp.error) throw stateUp.error;

  const folderUp = await admin
    .from("mail_folders")
    .update({ uidvalidity: Number(args.newUidValidity) })
    .eq("id", args.folderId);
  if (folderUp.error) throw folderUp.error;
}

/**
 * Upsert message metadata rows in bounded batches so a single sync round
 * never issues a huge single statement. Conflicts on
 * (account_id, folder_id, uidvalidity, uid) update in place.
 */
export async function upsertMessagesInBatches(
  admin: Admin,
  args: {
    accountId: string;
    companyId: string;
    folderId: string;
    uidValidity: string;
  },
  messages: readonly SyncMessagePayload[],
): Promise<number> {
  if (messages.length === 0) return 0;
  let wrote = 0;
  for (let i = 0; i < messages.length; i += UPSERT_CHUNK) {
    const slice = messages.slice(i, i + UPSERT_CHUNK);
    const chunk = slice.map((m) => mapSyncMessageToRow(args, m));
    const { error } = await admin
      .from("mail_messages")
      .upsert(chunk as never, { onConflict: "account_id,folder_id,uidvalidity,uid" });
    if (error) throw error;
    wrote += chunk.length;
  }
  return wrote;
}

/**
 * Apply CONDSTORE flag deltas. Only the flag columns are touched; envelope
 * data is left untouched.
 */
export async function applyFlagStates(
  admin: Admin,
  args: {
    accountId: string;
    folderId: string;
    uidValidity: string;
  },
  states: readonly SyncFlagStatePayload[],
): Promise<number> {
  if (states.length === 0) return 0;
  const uv = Number(args.uidValidity);
  let updated = 0;
  for (const s of states) {
    const patch = mapFlagStateToUpdate(s);
    const { error, count } = await admin
      .from("mail_messages")
      .update(patch, { count: "exact" })
      .eq("account_id", args.accountId)
      .eq("folder_id", args.folderId)
      .eq("uidvalidity", uv)
      .eq("uid", s.uid);
    if (error) throw error;
    updated += count ?? 0;
  }
  return updated;
}

/**
 * Reconcile a UID range: rows that exist locally but not in `presentUids`
 * are soft-deleted (tombstoned). Returns the number of tombstoned rows.
 */
export async function tombstoneMissingInRange(
  admin: Admin,
  args: {
    accountId: string;
    folderId: string;
    uidValidity: string;
    fromUid: number;
    toUid: number;
    presentUids: readonly number[];
  },
): Promise<number> {
  const uv = Number(args.uidValidity);
  const sel = await admin
    .from("mail_messages")
    .select("uid")
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId)
    .eq("uidvalidity", uv)
    .gte("uid", args.fromUid)
    .lte("uid", args.toUid)
    .is("deleted_at", null);
  if (sel.error) throw sel.error;
  const localUids = (sel.data ?? []).map((r) => Number(r.uid));
  const missing = computeTombstoneUids(localUids, args.presentUids);
  if (missing.length === 0) return 0;
  const nowIso = new Date().toISOString();
  let tombstoned = 0;
  for (let i = 0; i < missing.length; i += UPSERT_CHUNK) {
    const chunk = missing.slice(i, i + UPSERT_CHUNK);
    const { error } = await admin
      .from("mail_messages")
      .update({ deleted_at: nowIso })
      .eq("account_id", args.accountId)
      .eq("folder_id", args.folderId)
      .eq("uidvalidity", uv)
      .in("uid", chunk);
    if (error) throw error;
    tombstoned += chunk.length;
  }
  return tombstoned;
}

/** Recompute total/unread from live rows and write them to mail_folders. */
export async function refreshFolderCounts(
  admin: Admin,
  args: {
    accountId: string;
    folderId: string;
    uidValidity: string;
    /**
     * Blocker 2 — Authoritative Counts.
     *
     * IMAP is the source of truth for a folder's message count. Local COUNT(*)
     * of `mail_messages` returns only what we've synced (capped by the
     * incremental page size, e.g. 300), which surfaces to users as a Sidebar
     * total that undercounts real mailbox size.
     *
     * When the sync runner passes the freshly-observed IMAP `EXISTS` from
     * the mailbox status, we persist THAT as the folder total. `null` /
     * `undefined` / non-finite values fall back to the local COUNT for
     * backward compatibility with older callers and for folders where
     * EXISTS is genuinely unavailable.
     *
     * Unread stays local: mailbox status does not always return UNSEEN in
     * the sync payload; the Sidebar polls STATUS separately (via
     * `bridgeGetFolderCounts`) for the authoritative unread value.
     */
    authoritativeTotal?: number | null;
  },
): Promise<{ total: number; unread: number }> {
  const uv = Number(args.uidValidity);
  const unreadQ = admin
    .from("mail_messages")
    .select("*", { count: "exact", head: true })
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId)
    .eq("uidvalidity", uv)
    .is("deleted_at", null)
    .eq("seen", false);
  const hasAuthoritative =
    args.authoritativeTotal != null &&
    Number.isFinite(args.authoritativeTotal) &&
    args.authoritativeTotal >= 0;
  let total: number;
  if (hasAuthoritative) {
    total = Math.trunc(args.authoritativeTotal as number);
    const u = await unreadQ;
    if (u.error) throw u.error;
    const unread = Math.min(u.count ?? 0, total);
    const up = await admin.from("mail_folders").update({ total, unread }).eq("id", args.folderId);
    if (up.error) throw up.error;
    return { total, unread };
  }
  const totalQ = admin
    .from("mail_messages")
    .select("*", { count: "exact", head: true })
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId)
    .eq("uidvalidity", uv)
    .is("deleted_at", null);
  const [t, u] = await Promise.all([totalQ, unreadQ]);
  if (t.error) throw t.error;
  if (u.error) throw u.error;
  total = t.count ?? 0;
  const unread = u.count ?? 0;
  const up = await admin.from("mail_folders").update({ total, unread }).eq("id", args.folderId);
  if (up.error) throw up.error;
  return { total, unread };
}


/** Persist the freshest mailbox-level state onto the folder row. */
export async function writeFolderMailboxState(
  admin: Admin,
  folderId: string,
  mb: MailboxStatePayload,
): Promise<void> {
  const up = await admin
    .from("mail_folders")
    .update({
      uidvalidity: mb.uidValidity ? Number(mb.uidValidity) : null,
      uidnext: mb.uidNext,
      highest_modseq: mb.highestModseq == null ? null : Number(mb.highestModseq),
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", folderId);
  if (up.error) throw up.error;
}

/** Update the sync-state cursor after a successful (partial) sync. */
export async function updateSyncCursor(
  admin: Admin,
  args: {
    accountId: string;
    folderId: string;
    uidValidity: string;
    uidNext: number | null;
    highestModseq: string | null;
    oldestSyncedUid: number | null;
    newestSyncedUid: number | null;
    flagsNeedReconcile?: boolean | null;
    markReconciledAt?: boolean;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    uidvalidity: Number(args.uidValidity),
    uidnext: args.uidNext,
    highest_modseq: args.highestModseq == null ? null : Number(args.highestModseq),
  };
  if (args.oldestSyncedUid != null) patch.oldest_synced_uid = args.oldestSyncedUid;
  if (args.newestSyncedUid != null) patch.newest_synced_uid = args.newestSyncedUid;
  if (args.flagsNeedReconcile != null) patch.flags_need_reconcile = args.flagsNeedReconcile;
  if (args.markReconciledAt) patch.last_reconcile_at = new Date().toISOString();
  const up = await admin
    .from("mail_sync_state")
    .update(patch as never)
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId);
  if (up.error) throw up.error;
}

/** Read the current sync cursor (may be null if the row was just created). */
export async function readSyncCursor(
  admin: Admin,
  args: { accountId: string; folderId: string },
): Promise<{
  uidvalidity: string | null;
  uidnext: number | null;
  highest_modseq: string | null;
  oldest_synced_uid: number | null;
  newest_synced_uid: number | null;
  flags_need_reconcile: boolean;
} | null> {
  const { data, error } = await admin
    .from("mail_sync_state")
    .select(
      "uidvalidity, uidnext, highest_modseq, oldest_synced_uid, newest_synced_uid, flags_need_reconcile",
    )
    .eq("account_id", args.accountId)
    .eq("folder_id", args.folderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    uidvalidity: data.uidvalidity != null ? String(data.uidvalidity) : null,
    uidnext: data.uidnext,
    highest_modseq: data.highest_modseq != null ? String(data.highest_modseq) : null,
    oldest_synced_uid: data.oldest_synced_uid,
    newest_synced_uid: data.newest_synced_uid,
    flags_need_reconcile: !!data.flags_need_reconcile,
  };
}

// ==============================================================
// Atomic sync lock (thin wrappers over the DB functions)
// ==============================================================

export async function claimSyncLock(
  admin: Admin,
  args: {
    accountId: string;
    companyId: string;
    folderId: string | null;
    lockedBy: string;
    ttlSeconds: number;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_mail_sync_lock", {
    p_account_id: args.accountId,
    p_company_id: args.companyId,
    p_folder_id: args.folderId as string, // typed as string; DB accepts null
    p_locked_by: args.lockedBy,
    p_ttl_seconds: args.ttlSeconds,
  });
  if (error) throw error;
  return !!data;
}

export async function releaseSyncLock(
  admin: Admin,
  args: {
    accountId: string;
    companyId: string;
    folderId: string | null;
    lockedBy: string;
    status: "idle" | "error" | "disabled";
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("release_mail_sync_lock", {
    p_account_id: args.accountId,
    p_company_id: args.companyId,
    p_folder_id: args.folderId as string,
    p_locked_by: args.lockedBy,
    p_status: args.status,
    p_error_code: args.errorCode ?? undefined,
    p_error_msg: args.errorMessage ?? undefined,
  });
  if (error) throw error;
  return !!data;
}
