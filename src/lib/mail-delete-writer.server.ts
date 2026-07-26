// Server-only pure helpers for the Local Mail Index permanent-delete
// write-through path (Blocker 1).
//
// Called by `indexDeleteMessage` after a successful Bridge /api/delete on
// a trash source. IMAP is the source of truth: any DB failure here NEVER
// rolls the UI back — the message is already gone from the server. Counter
// adjustments run through the approved atomic RPC
// `public.adjust_mail_folder_counts_atomic` so two racing bulk-delete
// callers cannot corrupt totals via a Read-Modify-Write cycle.
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveFolderByCanonical, tombstoneSourceRow } from "./mail-move-writer.server";

export interface DeleteWriteThroughInput {
  accountId: string;
  companyId: string;
  /** Always "trash" for permanent-delete in Blocker 1; kept generic for future. */
  sourceCanonical: string;
  sourceUid: number;
}

export type DeleteWriteThroughOutcome =
  | {
      ok: true;
      applied: "tombstoned" | "already-tombstoned" | "no-source-folder";
      wasUnread: boolean;
    }
  | { ok: false; error: string };

export async function applyDeleteWriteThrough(
  supabase: SupabaseClient,
  input: DeleteWriteThroughInput,
): Promise<DeleteWriteThroughOutcome> {
  const src = await resolveFolderByCanonical(
    supabase,
    input.accountId,
    input.companyId,
    input.sourceCanonical,
  );
  if (!src || src.uidvalidity == null) {
    return { ok: true, applied: "no-source-folder", wasUnread: false };
  }

  const tomb = await tombstoneSourceRow(supabase, {
    accountId: input.accountId,
    folderId: src.id,
    uidvalidity: src.uidvalidity,
    uid: input.sourceUid,
  });

  // No matching row (already tombstoned / never indexed) — nothing to
  // decrement. Skipping the RPC prevents a false −1 on stale counters.
  if (!tomb) {
    return { ok: true, applied: "already-tombstoned", wasUnread: false };
  }

  const rpc = await supabase.rpc("adjust_mail_folder_counts_atomic", {
    p_folder_id: src.id,
    p_account_id: input.accountId,
    p_company_id: input.companyId,
    p_total_delta: -1,
    p_unread_delta: tomb.wasUnread ? -1 : 0,
  });
  if (rpc.error) {
    // Row is tombstoned; counter refresh will self-heal on next poll.
    return { ok: false, error: rpc.error.message };
  }

  return { ok: true, applied: "tombstoned", wasUnread: tomb.wasUnread };
}
