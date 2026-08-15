// Server-only Draft projection write-through (MAILMAESTRO_DRAFTS_V4).
//
// After a successful remote IMAP APPEND, the Draft route calls this to
// reflect the canonical server copy into the existing Local Mail Index
// (`mail_folders` + `mail_messages`) in the SAME request — no second browser
// round-trip, no second IMAP call, no schema migration.
//
// IMAP is the source of truth. A projection failure is swallowed by the
// caller and never turns a successful remote save into a failed one; the
// normal sync machinery reconciles the index later.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureFolderRow, mapSyncMessageToRow } from "./mail-sync-writer.server";
import { adjustFolderCountsDelta, tombstoneSourceRow } from "./mail-move-writer.server";

export interface DraftProjectionAddress {
  name: string | null;
  email: string;
}

export interface DraftProjectionInput {
  accountId: string;
  companyId: string;
  folderPath: string;
  uid: number | null;
  uidValidity: string;
  messageId: string | null;
  subject: string;
  from: DraftProjectionAddress;
  to: DraftProjectionAddress[];
  cc: DraftProjectionAddress[];
  internalDate: string;
  hasAttachments: boolean;
  previousRef: { folderPath: string; uid: number; uidValidity: string } | null | undefined;
}

/** Coerce a client-supplied address list into the SyncAddress wire shape. */
function toSyncAddresses(list: readonly DraftProjectionAddress[]): DraftProjectionAddress[] {
  return list
    .filter((a) => a && typeof a.email === "string" && a.email.length > 0)
    .map((a) => ({ name: typeof a.name === "string" ? a.name : null, email: a.email }));
}

export async function writeDraftProjection(
  supabase: SupabaseClient,
  input: DraftProjectionInput,
): Promise<void> {
  const uid = typeof input.uid === "number" && Number.isFinite(input.uid) ? input.uid : null;
  if (uid == null || uid <= 0) return;
  const uidValidityNum = Number(input.uidValidity);
  if (!Number.isFinite(uidValidityNum) || uidValidityNum <= 0) return;

  const folder = await ensureFolderRow(supabase, {
    accountId: input.accountId,
    companyId: input.companyId,
    path: input.folderPath,
    canonical: "drafts",
    supported: true,
  });
  const folderId = folder.folderId;

  // Make the folder index-ready when it was never synced: index-first listing
  // (indexListMessages) requires a non-null uidvalidity on the folder row.
  if (folder.storedUidValidity == null) {
    await supabase
      .from("mail_folders")
      .update({ uidvalidity: uidValidityNum })
      .eq("id", folderId);
  }

  // Replacement: tombstone the prior canonical projected UID exactly once.
  const prev = input.previousRef;
  if (
    prev &&
    prev.folderPath === input.folderPath &&
    String(prev.uidValidity) === input.uidValidity &&
    prev.uid !== uid
  ) {
    const tomb = await tombstoneSourceRow(supabase, {
      accountId: input.accountId,
      folderId,
      uidvalidity: uidValidityNum,
      uid: prev.uid,
    });
    if (tomb.changed) {
      await adjustFolderCountsDelta(supabase, {
        folderId,
        accountId: input.accountId,
        companyId: input.companyId,
        totalDelta: -1,
        unreadDelta: 0,
      });
    }
  }

  // Upsert the new canonical row. `ignoreDuplicates` + `.select()` proves the
  // insert actually happened so the counter is bumped exactly once per row.
  const row = mapSyncMessageToRow(
    {
      accountId: input.accountId,
      companyId: input.companyId,
      folderId,
      uidValidity: input.uidValidity,
    },
    {
      uid,
      modseq: null,
      messageId: input.messageId,
      inReplyTo: null,
      references: [],
      subject: input.subject,
      from: input.from,
      to: toSyncAddresses(input.to),
      cc: toSyncAddresses(input.cc),
      internalDate: input.internalDate,
      sizeBytes: null,
      hasAttachments: input.hasAttachments,
      flagSeen: true,
      flagFlagged: false,
      flagAnswered: false,
      flagDraft: true,
      keywords: [],
    },
  );

  const up = await supabase
    .from("mail_messages")
    .upsert(row as never, {
      onConflict: "account_id,folder_id,uidvalidity,uid",
      ignoreDuplicates: true,
    })
    .select("id");
  if (up.error) throw up.error;
  const inserted = Array.isArray(up.data) && up.data.length > 0;
  if (inserted) {
    await adjustFolderCountsDelta(supabase, {
      folderId,
      accountId: input.accountId,
      companyId: input.companyId,
      totalDelta: 1,
      unreadDelta: 0,
    });
  }
}

export interface DraftProjectionDeleteInput {
  accountId: string;
  companyId: string;
  folderPath: string;
  uid: number;
  uidValidity: string;
}

/**
 * Tombstone the derived Local Index row for a Draft after the authoritative
 * remote delete succeeded. Idempotent: only a currently-live row transitions,
 * and the folder count is decremented exactly once (guarded by the live-row
 * `select()`). A stale/missing row is a safe no-op.
 */
export async function tombstoneDraftProjection(
  supabase: SupabaseClient,
  input: DraftProjectionDeleteInput,
): Promise<{ changed: boolean }> {
  const uidValidityNum = Number(input.uidValidity);
  if (!Number.isFinite(uidValidityNum) || uidValidityNum <= 0) return { changed: false };
  if (!Number.isFinite(input.uid) || input.uid <= 0) return { changed: false };

  const folder = await ensureFolderRow(supabase, {
    accountId: input.accountId,
    companyId: input.companyId,
    path: input.folderPath,
    canonical: "drafts",
    supported: true,
  });

  const up = await supabase
    .from("mail_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("account_id", input.accountId)
    .eq("folder_id", folder.folderId)
    .eq("uidvalidity", uidValidityNum)
    .eq("uid", input.uid)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (up.error) throw up.error;
  if (!up.data?.id) return { changed: false };

  await adjustFolderCountsDelta(supabase, {
    folderId: folder.folderId,
    accountId: input.accountId,
    companyId: input.companyId,
    totalDelta: -1,
    unreadDelta: 0,
  });
  return { changed: true };
}
