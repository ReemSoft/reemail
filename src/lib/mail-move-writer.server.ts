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
): Promise<FolderRef | null> {
  const q = await supabase
    .from("mail_folders")
    .select("id, uidvalidity, path")
    .eq("account_id", accountId)
    .eq("path", path)
    .maybeSingle();
  if (q.error) throw q.error;
  if (!q.data?.id) return null;
  return {
    id: q.data.id,
    uidvalidity: q.data.uidvalidity == null ? null : Number(q.data.uidvalidity),
    path: q.data.path ?? null,
  };
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
 * (folderId, uidvalidity, uid). Used only when the Bridge returned a
 * UIDPLUS COPYUID mapping — the caller already validated uidvalidity.
 *
 * Uses UPSERT with onConflict on the (account, folder, uidvalidity, uid)
 * unique constraint so a racing incremental sync cannot cause a duplicate
 * or a "row already exists" hard error.
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
  const up = await supabase
    .from("mail_messages")
    .upsert(row as never, {
      onConflict: "account_id,folder_id,uidvalidity,uid",
      ignoreDuplicates: false,
    });
  if (up.error) throw up.error;
  return { inserted: true, wasUnread: !src.data.seen };
}

/** Apply a total/unread delta to a folder row atomically-in-application. */
export async function adjustFolderCountsDelta(
  supabase: SupabaseClient,
  params: { folderId: string; totalDelta: number; unreadDelta: number },
): Promise<void> {
  const sel = await supabase
    .from("mail_folders")
    .select("total, unread")
    .eq("id", params.folderId)
    .maybeSingle();
  if (sel.error) throw sel.error;
  if (!sel.data) return;
  const total = Math.max(0, (sel.data.total ?? 0) + params.totalDelta);
  const unread = Math.max(0, (sel.data.unread ?? 0) + params.unreadDelta);
  const up = await supabase.from("mail_folders").update({ total, unread }).eq("id", params.folderId);
  if (up.error) throw up.error;
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

  // 2) Tombstone source row.
  const tomb = await tombstoneSourceRow(supabase, {
    accountId: input.accountId,
    folderId: src.id,
    uidvalidity: src.uidvalidity,
    uid: input.sourceUid,
  });
  const sourceTombstoned = !!tomb;

  if (tomb) {
    await adjustFolderCountsDelta(supabase, {
      folderId: src.id,
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
      dst = await resolveFolderByPath(supabase, input.accountId, input.destinationPath);
    }
    if (dst && dst.uidvalidity != null && String(dst.uidvalidity) === destUvStr && tomb) {
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
      if (ins) {
        destinationInserted = true;
        await adjustFolderCountsDelta(supabase, {
          folderId: dst.id,
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
