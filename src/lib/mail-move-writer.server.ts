// Server-only pure helpers for the Local Mail Index MOVE write-through path.
//
// Called by `indexMoveMessage` after a successful Bridge /api/move. IMAP is
// the source of truth; a DB failure here NEVER rolls the UI back — we mark
// the source row tombstoned and, when the destination folder is unknown or
// the server did not return UIDPLUS COPYUID, we let the next incremental
// sync of the destination folder discover the new UID.
//
// Behavior contract:
//   * `starred` (a virtual view over INBOX + \Flagged) always normalizes to
//     `inbox` for local index lookup; the physical row lives under INBOX.
//   * When `uidMappingAvailable === true` AND the destination folder row
//     exists AND its uidvalidity matches: copy the source row's envelope
//     into a new destination row (uid = destinationUid), tombstone source,
//     and refresh both folder counts.
//   * Otherwise: tombstone source and mark destination needing sync.
//     `refreshFolderCounts` on the destination is safe to skip because the
//     targeted incremental sync will refresh it on the next round.
//   * Duplicate destination rows are prevented by ON CONFLICT DO NOTHING on
//     (account_id, folder_id, uidvalidity, uid).
import type { SupabaseClient } from "@supabase/supabase-js";

export type CanonicalFolder =
  | "inbox"
  | "starred"
  | "sent"
  | "drafts"
  | "spam"
  | "trash"
  | "archive"
  | "all";

/** Starred is a virtual view over INBOX; the physical mail_folders row is INBOX. */
export function normalizeCanonicalForIndex(canonical: string): string {
  return canonical === "starred" ? "inbox" : canonical;
}

export interface FolderRef {
  id: string;
  uidvalidity: number | null;
  path: string | null;
}

export async function resolveFolderByCanonical(
  supabase: SupabaseClient,
  accountId: string,
  companyId: string,
  canonical: string,
): Promise<FolderRef | null> {
  const q = await supabase
    .from("mail_folders")
    .select("id, uidvalidity, path")
    .eq("account_id", accountId)
    .eq("company_id", companyId)
    .eq("canonical", normalizeCanonicalForIndex(canonical))
    .maybeSingle();
  if (q.error) throw q.error;
  if (!q.data?.id) return null;
  return {
    id: q.data.id,
    uidvalidity: q.data.uidvalidity == null ? null : Number(q.data.uidvalidity),
    path: q.data.path ?? null,
  };
}

export async function resolveFolderByPath(
  supabase: SupabaseClient,
  accountId: string,
  path: string,
  companyId?: string,
): Promise<FolderRef | null> {
  let q = supabase
    .from("mail_folders")
    .select("id, uidvalidity, path")
    .eq("account_id", accountId)
    .eq("path", path);
  // Batch A / Fix #3: when the caller knows the company, scope the lookup to
  // it so a stray row on another tenant can never be returned. Legacy callers
  // that omit companyId keep working (single-tenant accounts).
  if (companyId) q = q.eq("company_id", companyId);
  const res = await q.maybeSingle();
  if (res.error) throw res.error;
  if (!res.data?.id) return null;
  return {
    id: res.data.id,
    uidvalidity: res.data.uidvalidity == null ? null : Number(res.data.uidvalidity),
    path: res.data.path ?? null,
  };
}


// ============================================================================
// Fingerprint capture + destination UID discovery (Blocker 2: targeted sync)
// ============================================================================

export interface MessageFingerprint {
  messageId: string | null;
  internalDate: string | null;
  sizeBytes: number | null;
  subject: string | null;
  fromEmail: string | null;
}

/**
 * Snapshot the identity of a locally-indexed row BEFORE a Move so we can
 * later find its new UID at the destination without trusting Bridge-provided
 * UIDs (many servers don't return UIDPLUS COPYUID). Returns null when the
 * row is missing — the caller must degrade gracefully in that case.
 */
export async function captureSourceFingerprint(
  supabase: SupabaseClient,
  params: { accountId: string; folderId: string; uidvalidity: number; uid: number },
): Promise<MessageFingerprint | null> {
  const q = await supabase
    .from("mail_messages")
    .select("message_id, internal_date, size_bytes, subject, from_addr")
    .eq("account_id", params.accountId)
    .eq("folder_id", params.folderId)
    .eq("uidvalidity", params.uidvalidity)
    .eq("uid", params.uid)
    .maybeSingle();
  if (q.error) throw q.error;
  if (!q.data) return null;
  const from = q.data.from_addr as { email?: unknown } | null;
  const fromEmail =
    from && typeof from === "object" && typeof from.email === "string"
      ? (from.email as string).toLowerCase()
      : null;
  return {
    messageId: (q.data.message_id as string | null) ?? null,
    internalDate: (q.data.internal_date as string | null) ?? null,
    sizeBytes: (q.data.size_bytes as number | null) ?? null,
    subject: (q.data.subject as string | null) ?? null,
    fromEmail,
  };
}

export interface DiscoveredDestination {
  uid: number;
  uidvalidity: number;
}

/**
 * Find the moved message's new UID at the destination folder using the
 * fingerprint captured before the Move.
 *
 * Priority:
 *   1) Match by `message_id` (fastest, most reliable). If exactly one live
 *      row above the cutoff matches → return it.
 *   2) Fingerprint match on (internal_date, size_bytes, subject, from.email)
 *      when the message_id was absent OR yielded 0/multiple rows. Only a
 *      unique candidate above the cutoff is accepted.
 *
 * `cutoffUid` is the destination folder's `newest_synced_uid` from BEFORE
 * the Move; anything at-or-below cutoff is treated as pre-existing and
 * ignored. This blocks stale duplicates (same Message-ID from an older
 * send) from being mistaken for the just-moved copy.
 *
 * Returns `null` when 0 or >1 candidates remain — callers surface this as
 * `destinationReady: false` rather than guessing a UID.
 */
export async function discoverDestinationUid(
  supabase: SupabaseClient,
  params: {
    accountId: string;
    folderId: string;
    uidvalidity: number;
    cutoffUid: number;
    fingerprint: MessageFingerprint;
  },
): Promise<DiscoveredDestination | null> {
  const acceptable = (rows: Array<{ uid: unknown; uidvalidity: unknown }>) => {
    if (rows.length !== 1) return null;
    const r = rows[0];
    const uid = Number(r.uid);
    const uidvalidity = Number(r.uidvalidity);
    // Reject anything that isn't a strictly-positive integer for both
    // fields. Guards against Postgres bigint strings that decode oddly,
    // NaN from NULL columns, or negative fixtures.
    if (!Number.isInteger(uid) || uid <= 0) return null;
    if (!Number.isInteger(uidvalidity) || uidvalidity <= 0) return null;
    return { uid, uidvalidity } as DiscoveredDestination;
  };


  if (params.fingerprint.messageId) {
    const q = await supabase
      .from("mail_messages")
      .select("uid, uidvalidity")
      .eq("account_id", params.accountId)
      .eq("folder_id", params.folderId)
      .eq("uidvalidity", params.uidvalidity)
      .eq("message_id", params.fingerprint.messageId)
      .gt("uid", params.cutoffUid)
      .is("deleted_at", null);
    if (q.error) throw q.error;
    const hit = acceptable((q.data ?? []) as Array<{ uid: unknown; uidvalidity: unknown }>);
    if (hit) return hit;
    // fall through to fingerprint
  }

  const fp = params.fingerprint;
  // Fingerprint fallback requires enough identity to be meaningful.
  if (fp.internalDate == null || fp.sizeBytes == null) return null;

  let q = supabase
    .from("mail_messages")
    .select("uid, uidvalidity, from_addr, subject")
    .eq("account_id", params.accountId)
    .eq("folder_id", params.folderId)
    .eq("uidvalidity", params.uidvalidity)
    .eq("internal_date", fp.internalDate)
    .eq("size_bytes", fp.sizeBytes)
    .gt("uid", params.cutoffUid)
    .is("deleted_at", null);
  if (fp.subject != null) q = q.eq("subject", fp.subject);
  const res = await q;
  if (res.error) throw res.error;
  const rows = (res.data ?? []) as Array<{
    uid: unknown;
    uidvalidity: unknown;
    from_addr: unknown;
    subject: unknown;
  }>;
  const filtered = fp.fromEmail
    ? rows.filter((r) => {
        const f = r.from_addr as { email?: unknown } | null;
        const e =
          f && typeof f === "object" && typeof f.email === "string"
            ? (f.email as string).toLowerCase()
            : null;
        return e === fp.fromEmail;
      })
    : rows;
  return acceptable(filtered);
}

/**
 * Idempotent, atomic soft-delete of a source row (identity:
 * account+folder+uidvalidity+uid). Uses a single conditional UPDATE with
 * `.is("deleted_at", null)` so two concurrent callers cannot both observe
 * "row changed" — Postgres serializes the WHERE + UPDATE and only one wins.
 *
 * Returns `{ changed: true, wasUnread }` exactly once per row. Any
 * subsequent call (row missing OR already tombstoned) returns
 * `{ changed: false }` — callers MUST NOT decrement folder counters when
 * `changed === false`, otherwise counts drift permanently on retries /
 * double-clicks.
 */
export type TombstoneResult = { changed: true; wasUnread: boolean } | { changed: false };

export async function tombstoneSourceRow(
  supabase: SupabaseClient,
  params: { accountId: string; folderId: string; uidvalidity: number; uid: number },
): Promise<TombstoneResult> {
  const up = await supabase
    .from("mail_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("account_id", params.accountId)
    .eq("folder_id", params.folderId)
    .eq("uidvalidity", params.uidvalidity)
    .eq("uid", params.uid)
    .is("deleted_at", null)
    .select("id, seen")
    .maybeSingle();
  if (up.error) throw up.error;
  if (!up.data?.id) return { changed: false };
  return { changed: true, wasUnread: !up.data.seen };
}

/**
 * Copy the source row's envelope into a fresh destination row at the given
 * (folderId, uidvalidity, uid).
 *
 * BLOCKER_7 (upsert race safety): uses `ignoreDuplicates: true` + `.select()`
 * so the DB — not us — decides whether an insert actually happened. If a
 * racing incremental sync already inserted this (folder, uidvalidity, uid)
 * row, its NEWER data is preserved (we do NOT overwrite with the source
 * envelope), and we return `{ inserted: false }`. Callers use that flag to
 * skip the destination counter increment (Sync's refreshFolderCounts owns
 * the count in that case) and avoid double-counting.
 */
export async function insertDestinationRowFromSource(
  supabase: SupabaseClient,
  args: {
    accountId: string;
    companyId: string;
    sourceFolderId: string;
    sourceUidvalidity: number;
    sourceUid: number;
    destinationFolderId: string;
    destinationUidvalidity: number;
    destinationUid: number;
  },
): Promise<{ inserted: boolean; wasUnread: boolean } | null> {
  const src = await supabase
    .from("mail_messages")
    .select(
      "modseq, message_id, in_reply_to, subject, from_addr, to_addrs, cc_addrs, internal_date, size_bytes, has_attachments, seen, flagged, answered, draft, keywords",
    )
    .eq("account_id", args.accountId)
    .eq("folder_id", args.sourceFolderId)
    .eq("uidvalidity", args.sourceUidvalidity)
    .eq("uid", args.sourceUid)
    .maybeSingle();
  if (src.error) throw src.error;
  if (!src.data) return null;

  const row = {
    account_id: args.accountId,
    company_id: args.companyId,
    folder_id: args.destinationFolderId,
    uid: args.destinationUid,
    uidvalidity: args.destinationUidvalidity,
    modseq: null as number | null,
    message_id: src.data.message_id,
    in_reply_to: src.data.in_reply_to,
    subject: src.data.subject,
    from_addr: src.data.from_addr,
    to_addrs: src.data.to_addrs,
    cc_addrs: src.data.cc_addrs,
    internal_date: src.data.internal_date,
    size_bytes: src.data.size_bytes,
    has_attachments: src.data.has_attachments,
    seen: src.data.seen,
    flagged: src.data.flagged,
    answered: src.data.answered,
    draft: src.data.draft,
    keywords: src.data.keywords,
    deleted_at: null as string | null,
  };
  // ignoreDuplicates=true: if the (account, folder, uidvalidity, uid) row
  // already exists (racing Sync won), Postgres does DO NOTHING; the SELECT
  // returns 0 rows. Otherwise the SELECT returns the freshly-inserted row.
  const up = await supabase
    .from("mail_messages")
    .upsert(row as never, {
      onConflict: "account_id,folder_id,uidvalidity,uid",
      ignoreDuplicates: true,
    })
    .select("id");
  if (up.error) throw up.error;
  const inserted = Array.isArray(up.data) && up.data.length > 0;
  return { inserted, wasUnread: !src.data.seen };
}

/**
 * Apply a total/unread delta to a folder row via the approved atomic RPC
 * `public.adjust_mail_folder_counts_atomic`. BLOCKER_4: this is the ONLY
 * path allowed to mutate folder counts on the Move / Delete / Restore
 * write-through hot paths — a Read-Modify-Write is unsafe under
 * concurrent bulk operations.
 *
 * `accountId` and `companyId` are REQUIRED so the RPC can enforce identity
 * (guards against a folderId collision across companies / accounts).
 */
export async function adjustFolderCountsDelta(
  supabase: SupabaseClient,
  params: {
    folderId: string;
    accountId: string;
    companyId: string;
    totalDelta: number;
    unreadDelta: number;
  },
): Promise<void> {
  const rpc = await supabase.rpc("adjust_mail_folder_counts_atomic", {
    p_folder_id: params.folderId,
    p_account_id: params.accountId,
    p_company_id: params.companyId,
    p_total_delta: params.totalDelta,
    p_unread_delta: params.unreadDelta,
  });
  if (rpc.error) throw rpc.error;
}


/**
 * Bump the destination folder's `uidnext` past the newly-arrived UID so a
 * subsequent incremental sync knows about the new tail. Safe no-op when
 * the destination folder row is missing.
 */
export async function bumpFolderUidnext(
  supabase: SupabaseClient,
  params: { folderId: string; uidnext: number },
): Promise<void> {
  const sel = await supabase
    .from("mail_folders")
    .select("uidnext")
    .eq("id", params.folderId)
    .maybeSingle();
  if (sel.error) throw sel.error;
  if (!sel.data) return;
  const cur = sel.data.uidnext == null ? 0 : Number(sel.data.uidnext);
  if (params.uidnext > cur) {
    const up = await supabase
      .from("mail_folders")
      .update({ uidnext: params.uidnext })
      .eq("id", params.folderId);
    if (up.error) throw up.error;
  }
}

// ============================================================================
// Top-level orchestrator
// ============================================================================

export interface MoveWriteThroughInput {
  accountId: string;
  companyId: string;
  sourceCanonical: string;
  destCanonical: string;
  sourceUid: number;
  destinationPath?: string;
  destinationUid?: number;
  destinationUidValidity?: string;
  uidMappingAvailable: boolean;
}

export type MoveWriteThroughOutcome =
  | {
      ok: true;
      applied: "full" | "source-only" | "no-source-folder";
      sourceTombstoned: boolean;
      destinationInserted: boolean;
    }
  | { ok: false; error: string };

export async function applyMoveWriteThrough(
  supabase: SupabaseClient,
  input: MoveWriteThroughInput,
): Promise<MoveWriteThroughOutcome> {
  // 1) Resolve source folder (canonical, starred→inbox normalized).
  const src = await resolveFolderByCanonical(
    supabase,
    input.accountId,
    input.companyId,
    input.sourceCanonical,
  );
  if (!src) {
    return {
      ok: true,
      applied: "no-source-folder",
      sourceTombstoned: false,
      destinationInserted: false,
    };
  }
  if (src.uidvalidity == null) {
    return {
      ok: true,
      applied: "no-source-folder",
      sourceTombstoned: false,
      destinationInserted: false,
    };
  }

  // 2) Tombstone source row atomically (idempotent on retry / double-move).
  const tomb = await tombstoneSourceRow(supabase, {
    accountId: input.accountId,
    folderId: src.id,
    uidvalidity: src.uidvalidity,
    uid: input.sourceUid,
  });
  const sourceTombstoned = tomb.changed;

  if (tomb.changed) {
    await adjustFolderCountsDelta(supabase, {
      folderId: src.id,
      accountId: input.accountId,
      companyId: input.companyId,
      totalDelta: -1,
      unreadDelta: tomb.wasUnread ? -1 : 0,
    });
  }

  // 3) Try destination write when we have a UID mapping AND the destination
  // folder row exists AND its uidvalidity matches. Otherwise leave the
  // destination alone — the next targeted incremental sync will discover
  // the new UID (its uidnext bump above helps that sync converge fast).
  let destinationInserted = false;
  const destUidNum =
    typeof input.destinationUid === "number" && Number.isFinite(input.destinationUid)
      ? input.destinationUid
      : null;
  const destUvStr = input.destinationUidValidity ?? null;

  if (input.uidMappingAvailable && destUidNum != null && destUvStr != null) {
    // Prefer canonical lookup (safer for the "trash"/"archive" case where
    // canonical is authoritative), fall back to path lookup only when
    // canonical yields nothing but bridge provided a path.
    let dst = await resolveFolderByCanonical(
      supabase,
      input.accountId,
      input.companyId,
      input.destCanonical,
    );
    if (!dst && input.destinationPath) {
      dst = await resolveFolderByPath(supabase, input.accountId, input.destinationPath, input.companyId);
    }

    // Only attempt destination insert when this caller actually won the
    // source-tombstone race. If a sibling won, they handled the destination
    // side too — inserting again would double-count.
    if (dst && dst.uidvalidity != null && String(dst.uidvalidity) === destUvStr && tomb.changed) {
      const ins = await insertDestinationRowFromSource(supabase, {
        accountId: input.accountId,
        companyId: input.companyId,
        sourceFolderId: src.id,
        sourceUidvalidity: src.uidvalidity,
        sourceUid: input.sourceUid,
        destinationFolderId: dst.id,
        destinationUidvalidity: Number(destUvStr),
        destinationUid: destUidNum,
      });
      // BLOCKER_7: `inserted` is proven from the DB (upsert.select() length),
      // not assumed from a non-null return value. If a racing Sync already
      // inserted the row, `inserted === false` — we skip the counter delta
      // so refreshFolderCounts (owned by Sync) stays authoritative and we
      // never double-count.
      if (ins && ins.inserted) {
        destinationInserted = true;
        await adjustFolderCountsDelta(supabase, {
          folderId: dst.id,
          accountId: input.accountId,
          companyId: input.companyId,
          totalDelta: 1,
          unreadDelta: ins.wasUnread ? 1 : 0,
        });
        await bumpFolderUidnext(supabase, {
          folderId: dst.id,
          uidnext: destUidNum + 1,

        });
      }
    }
  }

  return {
    ok: true,
    applied: destinationInserted ? "full" : "source-only",
    sourceTombstoned,
    destinationInserted,
  };
}
