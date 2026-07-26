// Server-only pure helpers for the Local Mail Index flag write-through path.
//
// Extracted from `mail-flags.functions.ts` so the DB behavior can be exercised
// under unit tests with a mocked Supabase client. The server function calls
// these helpers after JWT verification and Bridge success.
//
// Behavior contract (matches production flow):
//   * IMAP is the source of truth. On IMAP success we attempt a best-effort
//     local index update. Any DB failure sets flags_need_reconcile=true so the
//     next reconcile round applies IMAP truth back to the index — the UI is
//     never rolled back.
//   * `seen` mutations also refresh the folder's unread head-count so counters
//     stay live without a full folder scan.
//
// This module is server-only by the `.server.ts` filename convention.
import type { SupabaseClient } from "@supabase/supabase-js";

export type MailFlagKind = "seen" | "flagged";

export interface FolderRef {
  id: string;
  uidvalidity: number;
}

/** Resolve a folder row by (account_id, company_id, canonical). Returns null
 *  when the folder has not been indexed yet or has no uidvalidity assigned. */
export async function resolveFolderForFlag(
  supabase: SupabaseClient,
  accountId: string,
  companyId: string,
  canonical: string,
): Promise<FolderRef | null> {
  const q = await supabase
    .from("mail_folders")
    .select("id, uidvalidity")
    .eq("account_id", accountId)
    .eq("company_id", companyId)
    .eq("canonical", canonical)
    .maybeSingle();
  if (q.error) throw q.error;
  if (!q.data?.id || q.data.uidvalidity == null) return null;
  return { id: q.data.id, uidvalidity: Number(q.data.uidvalidity) };
}

/** Apply a single-message flag change scoped by (account, folder, uidvalidity,
 *  uid). Company scoping is enforced by the caller via `resolveFolderForFlag`. */
export async function updateMessageFlag(
  supabase: SupabaseClient,
  params: {
    accountId: string;
    folderId: string;
    uidvalidity: number;
    uid: number;
    kind: MailFlagKind;
    value: boolean;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (params.kind === "seen") patch.seen = params.value;
  else patch.flagged = params.value;

  const up = await supabase
    .from("mail_messages")
    .update(patch as never)
    .eq("account_id", params.accountId)
    .eq("folder_id", params.folderId)
    .eq("uidvalidity", params.uidvalidity)
    .eq("uid", params.uid);
  if (up.error) throw up.error;
}

/** Recompute the folder's unread count via a head-only count query and write
 *  it back to `mail_folders.unread`. Cheap: PostgREST head+count avoids row
 *  materialization. Called only when a `seen` flag changes. */
export async function recomputeFolderUnread(
  supabase: SupabaseClient,
  params: { accountId: string; folderId: string; uidvalidity: number },
): Promise<number> {
  const q = await supabase
    .from("mail_messages")
    .select("*", { count: "exact", head: true })
    .eq("account_id", params.accountId)
    .eq("folder_id", params.folderId)
    .eq("uidvalidity", params.uidvalidity)
    .is("deleted_at", null)
    .eq("seen", false);
  if (q.error) throw q.error;
  const unread = q.count ?? 0;
  const up = await supabase.from("mail_folders").update({ unread }).eq("id", params.folderId);
  if (up.error) throw up.error;
  return unread;
}

/** Mark a folder as needing flag reconcile. Used when IMAP succeeded but the
 *  local index write failed — the next scheduled reconcile will re-apply
 *  IMAP truth so we never roll back the optimistic UI. */
export async function markFolderNeedsFlagReconcile(
  supabase: SupabaseClient,
  params: { accountId: string; folderId: string },
): Promise<void> {
  const up = await supabase
    .from("mail_sync_state")
    .update({ flags_need_reconcile: true })
    .eq("account_id", params.accountId)
    .eq("folder_id", params.folderId);
  if (up.error) throw up.error;
}
