import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  WORKING_DRAFT_ATTACHMENT_BUCKET,
  WORKING_DRAFT_MAX_ATTACHMENT_BYTES,
  emptyWorkingDraftPayload,
  isWorkingDraftAttachmentReference,
  isWorkingDraftPayload,
  filterSentWorkingDraftRecords,
  type WorkingDraftAttachmentReference,
  type WorkingDraftPayload,
  type WorkingDraftRecord,
  type WorkingDraftSentRef,
  type WorkingDraftAttachmentContent,
  type WorkingDraftSourceDescriptor,
} from "@/lib/mail-working-draft";
import { isDefinitePreSmtpSendError } from "@/lib/mail-working-draft-send-idempotency";
import type { DraftServerRef } from "@/lib/mail-draft-lifecycle";
import { trackCloudflareWork } from "@/lib/cloudflare-wait-until.server";
import {
  mapWithBoundedConcurrency,
  WORKING_DRAFT_STAGE_CONCURRENCY,
} from "@/lib/mail-working-draft-bounded";
import { isDraftProviderCheckpointFenced } from "@/lib/mail-draft-provider-checkpoint";

type UntypedDb = {
  from(table: string): any;
  rpc(name: string, args?: Record<string, unknown>): any;
  storage: { from(bucket: string): any };
};

const discardedCleanupFlights = new Map<string, Promise<void>>();

type WorkingDraftRow = {
  id: string;
  company_id: string;
  account_id: string;
  payload: unknown;
  revision: number;
  remote_checkpoint_revision: number;
  remote_checkpoint_state: "pending" | "running" | "checkpointed" | "failed";
  remote_checkpoint_error: string | null;
  remote_server_ref: unknown;
  updated_at: string;
};

type AttachmentRow = {
  id: string;
  draft_id: string;
  company_id: string;
  account_id: string;
  client_key: string;
  kind: "attachment" | "inline-image";
  filename: string;
  mime_type: string;
  size_bytes: number;
  disposition: string | null;
  cid: string | null;
  storage_path: string | null;
  source_descriptor: unknown;
};

export type WorkingDraftAuth = {
  ok: true;
  accountId: string;
  companyId: string;
};

type WorkingDraftSendClaim = {
  claimed: boolean;
  state: "preparing" | "sending" | "sent" | "failed" | "discarded";
  smtpResult: Record<string, unknown> | null;
  error: string | null;
};

class DraftSendRejectedError extends Error {}

export type WorkingDraftError = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type WorkingDraftAuthResult = WorkingDraftAuth | WorkingDraftError;

function db(): UntypedDb {
  return supabaseAdmin as unknown as UntypedDb;
}

function authError(status: number, code: string, error: string): WorkingDraftError {
  return { ok: false, status, code, error };
}

function sendClaimFromRpc(data: unknown): WorkingDraftSendClaim | null {
  if (!Array.isArray(data)) return null;
  const row = data[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.state !== "string") return null;
  return {
    claimed: row.claimed === true,
    state: row.state as WorkingDraftSendClaim["state"],
    smtpResult:
      row.smtp_result && typeof row.smtp_result === "object"
        ? (row.smtp_result as Record<string, unknown>)
        : null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

function isAuthError(value: WorkingDraftAuthResult): value is WorkingDraftError {
  return value.ok === false;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function asServerRef(value: unknown): DraftServerRef | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  return typeof ref.folderPath === "string" &&
    Number.isSafeInteger(ref.uid) &&
    Number(ref.uid) > 0 &&
    typeof ref.uidValidity === "string"
    ? { folderPath: ref.folderPath, uid: Number(ref.uid), uidValidity: ref.uidValidity }
    : null;
}

function attachmentStoragePath(auth: WorkingDraftAuth, draftId: string, attachmentId: string): string {
  return `${auth.companyId}/${auth.accountId}/${draftId}/${attachmentId}`;
}

function safeAttachmentRows(data: unknown): AttachmentRow[] {
  return Array.isArray(data) ? (data as AttachmentRow[]) : [];
}

function recordFromRow(row: WorkingDraftRow): WorkingDraftRecord | null {
  if (!isWorkingDraftPayload(row.payload)) return null;
  return {
    draftId: row.id,
    revision: Number(row.revision),
    payload: row.payload,
    checkpoint: {
      revision: Number(row.remote_checkpoint_revision),
      committedRevision: Number(row.remote_checkpoint_revision),
      state: row.remote_checkpoint_state,
      serverRef: asServerRef(row.remote_server_ref),
      error: row.remote_checkpoint_error,
    },
    updatedAt: row.updated_at,
  };
}

/** Authenticate only the claimed tenant/account; no Bridge round trip is needed for working saves. */
export async function resolveWorkingDraftAuth(
  mailSessionToken: string,
): Promise<WorkingDraftAuthResult> {
  const { verifyBridgeAuthClaims } = await import("@/lib/mail-bridge-auth.server");
  const claims = await verifyBridgeAuthClaims(mailSessionToken);
  if (!("sub" in claims) || !("cid" in claims)) {
    return authError(claims.status, claims.code, claims.error);
  }
  const { data, error } = await db()
    .from("mail_accounts")
    .select("id, company_id")
    .eq("id", claims.sub)
    .eq("company_id", claims.cid)
    .maybeSingle();
  if (error) return authError(500, "ACCOUNT_LOOKUP_FAILED", "تعذر التحقق من حساب البريد.");
  if (!data) return authError(403, "ACCOUNT_FORBIDDEN", "لا تملك صلاحية الوصول إلى هذا الحساب.");
  return { ok: true, accountId: claims.sub, companyId: claims.cid };
}

export async function loadWorkingDraft(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<WorkingDraftRecord | null> {
  if (!isUuid(draftId)) throw new Error("INVALID_DRAFT_ID");
  const { data, error } = await db()
    .from("mail_working_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .maybeSingle();
  if (error) throw new Error("WORKING_DRAFT_LOAD_FAILED");
  return data ? recordFromRow(data as WorkingDraftRow) : null;
}

async function finishDiscardedCleanup(
  auth: WorkingDraftAuth,
  draftId: string,
  removedRef: DraftServerRef | null,
): Promise<boolean> {
  const { data, error } = await db().rpc(
    "finish_mail_working_draft_discard_cleanup",
    {
      p_draft_id: draftId,
      p_company_id: auth.companyId,
      p_account_id: auth.accountId,
      p_removed_ref: removedRef ?? null,
    },
  );
  if (error) throw new Error("DISCARD_CLEANUP_ADVANCE_FAILED");
  return data === true;
}

async function cleanupDiscardedWorkingDraft(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<void> {
  const tombstone = await db()
    .from("mail_working_draft_discards")
    .select("provider_refs, cleanup_state")
    .eq("draft_id", draftId)
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .maybeSingle();
  if (!tombstone.data) return;

  const rawRefs: unknown[] = Array.isArray(tombstone.data.provider_refs)
    ? tombstone.data.provider_refs
    : [];
  const providerRefs = rawRefs.flatMap((ref: unknown) => {
    const parsed = asServerRef(ref);
    return parsed ? [parsed] : [];
  });

  let storagePaths: string[] = [];
  try {
    const rows = await attachmentRows(auth, draftId);
    storagePaths = rows.flatMap((row) =>
      row.storage_path ? [row.storage_path] : [],
    );
  } catch {
    // Storage cleanup is best-effort and cannot block the durable tombstone.
  }

  let allProviderDeletesSucceeded = true;
  const advance = async (ref: DraftServerRef | null): Promise<boolean> => {
    try {
      return await finishDiscardedCleanup(auth, draftId, ref);
    } catch {
      return false;
    }
  };

  if (providerRefs.length > 0) {
    for (const ref of providerRefs) {
      let deleted = false;
      try {
        const result = await deleteProviderDraftExplicit({
          auth,
          draftId,
          previousRef: ref,
        });
        deleted = result.ok;
      } catch {
        deleted = false;
      }
      if (!deleted) {
        allProviderDeletesSucceeded = false;
        continue;
      }
      await advance(ref);
    }
  } else {
    let deleted = false;
    try {
      const result = await deleteProviderDraftExplicit({
        auth,
        draftId,
        previousRef: null,
      });
      deleted = result.ok;
    } catch {
      deleted = false;
    }
    if (!deleted) {
      allProviderDeletesSucceeded = false;
    }
  }

  if (!allProviderDeletesSucceeded) return;

  const purged = await advance(null);
  if (purged && storagePaths.length > 0) {
    try {
      await db()
        .storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET)
        .remove(storagePaths);
    } catch {
      // Owned storage removal is best-effort after the durable row is gone.
    }
  }
}

function startDiscardedCleanup(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<void> {
  const key = `${auth.companyId}:${auth.accountId}:${draftId}`;
  const existing = discardedCleanupFlights.get(key);
  if (existing) return existing;
  const flight = cleanupDiscardedWorkingDraft(auth, draftId);
  discardedCleanupFlights.set(key, flight);
  void flight.finally(() => {
    if (discardedCleanupFlights.get(key) === flight) {
      discardedCleanupFlights.delete(key);
    }
  });
  return flight;
}

/** Draft-folder-only projection for cross-device access before IMAP catches up. */
export async function listWorkingDrafts(
  auth: WorkingDraftAuth,
): Promise<{
  records: WorkingDraftRecord[];
  sentDraftRefs: WorkingDraftSentRef[];
  sendingProviderRefs: WorkingDraftSentRef[];
  discardedProviderRefs: WorkingDraftSentRef[];
}> {
  const { data, error } = await db()
    .from("mail_working_drafts")
    .select("*")
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("WORKING_DRAFT_LIST_FAILED");
  const sent = await db()
    .from("mail_working_draft_sends")
    .select("draft_id")
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .eq("state", "sent");
  const sending = await db()
    .from("mail_working_draft_sends")
    .select("draft_id")
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .eq("state", "sending");
  const sentIds = new Set<string>(
    Array.isArray(sent.data)
      ? (sent.data as Array<{ draft_id: string }>).map((row) => row.draft_id)
      : [],
  );
  const sendingIds = new Set<string>(
    Array.isArray(sending.data)
      ? (sending.data as Array<{ draft_id: string }>).map((row) => row.draft_id)
      : [],
  );
  const discards = await db()
    .from("mail_working_draft_discards")
    .select("draft_id, provider_refs, cleanup_state")
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId);
  const discardRows = Array.isArray(discards.data) ? (discards.data as Array<{
    draft_id: string;
    provider_refs: unknown;
    cleanup_state: string;
  }>) : [];
  const discardIds = new Set(discardRows.map((row) => row.draft_id));
  const rows = Array.isArray(data) ? (data as WorkingDraftRow[]) : [];
  const records = rows
    .map((row) => recordFromRow(row))
    .filter(
      (record): record is WorkingDraftRecord =>
        record !== null && !discardIds.has(record.draftId),
    );

  const sentDraftRefs: WorkingDraftSentRef[] = records
    .filter((record) => sentIds.has(record.draftId))
    .map((record) => ({
      draftId: record.draftId,
      serverRef: record.checkpoint.serverRef,
    }));
  const sendingProviderRefs: WorkingDraftSentRef[] = records
    .filter((record) => sendingIds.has(record.draftId))
    .map((record) => ({
      draftId: record.draftId,
      serverRef: record.checkpoint.serverRef,
    }));
  const discardedProviderRefs: WorkingDraftSentRef[] = discardRows.flatMap((row) => {
    const refs = Array.isArray(row.provider_refs) ? row.provider_refs : [];
    return refs.flatMap((ref) => {
      const serverRef = asServerRef(ref);
      return serverRef ? [{ draftId: row.draft_id, serverRef }] : [];
    });
  });

  for (const row of discardRows) {
    const refs = Array.isArray(row.provider_refs) ? row.provider_refs : [];
    if (row.cleanup_state !== "cleaned" || refs.length > 0) {
      trackCloudflareWork(startDiscardedCleanup(auth, row.draft_id));
    }
  }

  for (const record of records) {
    if (!sentIds.has(record.draftId)) continue;
    const cleanup = (async () => {
      try {
        await deleteWorkingDraftExplicit({
          auth,
          draftId: record.draftId,
          previousRef: record.checkpoint.serverRef ?? null,
        });
      } catch {
        // Row remains durable and hidden by sentDraftRefs until a later retry.
      }
    })();
    trackCloudflareWork(cleanup);
  }

  return {
    records: filterSentWorkingDraftRecords(records, sentIds),
    sentDraftRefs,
    sendingProviderRefs,
    discardedProviderRefs,
  };
}

async function attachmentRows(auth: WorkingDraftAuth, draftId: string): Promise<AttachmentRow[]> {
  const { data, error } = await db()
    .from("mail_working_draft_attachments")
    .select("*")
    .eq("draft_id", draftId)
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId);
  if (error) throw new Error("WORKING_DRAFT_ATTACHMENT_LOAD_FAILED");
  return safeAttachmentRows(data);
}

/**
 * Reads one MailMaestro-owned object after tenant/account and draft ownership
 * have been checked. This is used only to display an owned inline image;
 * normal attachment cards intentionally never call it.
 */
export async function readWorkingDraftAttachment(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  attachmentId: string;
}): Promise<WorkingDraftAttachmentContent> {
  if (!isUuid(input.draftId) || !isUuid(input.attachmentId)) {
    throw new Error("INVALID_ATTACHMENT_READ");
  }
  const { data, error } = await db()
    .from("mail_working_draft_attachments")
    .select("*")
    .eq("id", input.attachmentId)
    .eq("draft_id", input.draftId)
    .eq("company_id", input.auth.companyId)
    .eq("account_id", input.auth.accountId)
    .maybeSingle();
  if (error) throw new Error("ATTACHMENT_LOOKUP_FAILED");
  const row = data as AttachmentRow | null;
  if (!row?.storage_path) throw new Error("ATTACHMENT_BYTES_UNAVAILABLE");
  const downloaded = await db().storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).download(row.storage_path);
  if (downloaded.error || !downloaded.data) throw new Error("ATTACHMENT_STORAGE_READ_FAILED");
  const bytes = downloaded.data as Blob;
  if (bytes.size !== Number(row.size_bytes) || bytes.size > WORKING_DRAFT_MAX_ATTACHMENT_BYTES) {
    throw new Error("ATTACHMENT_STORAGE_SIZE_MISMATCH");
  }
  return {
    attachmentId: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    cid: row.cid ?? undefined,
    bytes,
  };
}

/**
 * Synchronizes metadata only after the optimistic document write succeeded.
 * The payload remains authoritative and carries enough metadata to repair an
 * interrupted secondary-row update on the next load/save.
 */
async function syncAttachmentReferences(
  auth: WorkingDraftAuth,
  draftId: string,
  references: readonly WorkingDraftAttachmentReference[],
): Promise<void> {
  const client = db();
  const existing = await attachmentRows(auth, draftId);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const byClientKey = new Map(existing.map((row) => [row.client_key, row]));
  const retainedIds = new Set<string>();

  for (const reference of references) {
    if (!isWorkingDraftAttachmentReference(reference)) throw new Error("INVALID_ATTACHMENT_REFERENCE");
    if (reference.attachmentId) {
      const owned = byId.get(reference.attachmentId);
      if (!owned || owned.client_key !== reference.clientKey || !owned.storage_path) {
        throw new Error("ATTACHMENT_OWNERSHIP_MISMATCH");
      }
      if (owned.kind !== reference.kind) throw new Error("ATTACHMENT_KIND_MISMATCH");
      const { error } = await client
        .from("mail_working_draft_attachments")
        .update({
          filename: reference.filename,
          mime_type: reference.mimeType,
          size_bytes: reference.size,
          disposition: reference.disposition ?? null,
          cid: reference.cid ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", owned.id)
        .eq("draft_id", draftId)
        .eq("company_id", auth.companyId)
        .eq("account_id", auth.accountId);
      if (error) throw new Error("ATTACHMENT_METADATA_UPDATE_FAILED");
      retainedIds.add(owned.id);
      continue;
    }

    const current = byClientKey.get(reference.clientKey);
    if (current?.storage_path) {
      // The row was already imported into its private object by an earlier
      // checkpoint/send pass, while this client reference still only knows the
      // stable clientKey (the browser never learns the generated attachmentId
      // for a provider-sourced attachment). Ownership is already proven by the
      // draft/company/account scoping of `existing`, so adopt the owned row
      // instead of rejecting the save with ATTACHMENT_ID_REQUIRED.
      if (current.kind !== reference.kind) throw new Error("ATTACHMENT_KIND_MISMATCH");
      const { error } = await client
        .from("mail_working_draft_attachments")
        .update({
          filename: reference.filename,
          mime_type: reference.mimeType,
          disposition: reference.disposition ?? null,
          cid: reference.cid ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", current.id)
        .eq("draft_id", draftId)
        .eq("company_id", auth.companyId)
        .eq("account_id", auth.accountId);
      if (error) throw new Error("ATTACHMENT_METADATA_UPDATE_FAILED");
      retainedIds.add(current.id);
      continue;
    }
    if (!reference.source) throw new Error("ATTACHMENT_SOURCE_REQUIRED");

    const row = {
      id: current?.id ?? randomUUID(),
      draft_id: draftId,
      company_id: auth.companyId,
      account_id: auth.accountId,
      client_key: reference.clientKey,
      kind: reference.kind,
      filename: reference.filename,
      mime_type: reference.mimeType,
      size_bytes: reference.size,
      disposition: reference.disposition ?? null,
      cid: reference.cid ?? null,
      storage_path: null,
      source_descriptor: reference.source,
    };
    const { error } = await client
      .from("mail_working_draft_attachments")
      .upsert(row, { onConflict: "draft_id,client_key" });
    if (error) throw new Error("ATTACHMENT_SOURCE_UPSERT_FAILED");
    retainedIds.add(row.id);
  }

  const stale = existing.filter((row) => !retainedIds.has(row.id));
  if (stale.length === 0) return;
  const { error } = await client
    .from("mail_working_draft_attachments")
    .delete()
    .in("id", stale.map((row) => row.id))
    .eq("draft_id", draftId)
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId);
  if (error) throw new Error("ATTACHMENT_PRUNE_FAILED");
  const paths = stale.flatMap((row) => (row.storage_path ? [row.storage_path] : []));
  if (paths.length > 0) {
    await client.storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).remove(paths);
  }
}

export async function saveWorkingDraft(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  expectedRevision: number;
  payload: WorkingDraftPayload;
}): Promise<{ ok: true; revision: number; serverRef: DraftServerRef | null } | { ok: false; conflict: true; revision: number }> {
  if (!isUuid(input.draftId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("INVALID_WORKING_DRAFT_MUTATION");
  }
  await ensureDraftNotDiscarded(input.auth, input.draftId);
  if (!isWorkingDraftPayload(input.payload)) throw new Error("INVALID_WORKING_DRAFT_PAYLOAD");
  const result = await db().rpc("save_mail_working_draft", {
    p_draft_id: input.draftId,
    p_company_id: input.auth.companyId,
    p_account_id: input.auth.accountId,
    p_expected_revision: input.expectedRevision,
    p_payload: input.payload,
  });
  if (result.error) {
    if (isDraftDiscardedRpcError(result.error)) throw new Error("DRAFT_DISCARDED");
    throw new Error("WORKING_DRAFT_SAVE_FAILED");
  }
  const reply = Array.isArray(result.data) ? result.data[0] : null;
  if (!reply || !Number.isSafeInteger(Number(reply.revision))) throw new Error("WORKING_DRAFT_SAVE_INVALID_REPLY");
  if (reply.conflict === true) return { ok: false, conflict: true, revision: Number(reply.revision) };
  await syncAttachmentReferences(input.auth, input.draftId, input.payload.attachments);
  const current = await loadWorkingDraft(input.auth, input.draftId);
  return { ok: true, revision: Number(reply.revision), serverRef: current?.checkpoint.serverRef ?? null };
}

/** A browser file crosses this boundary once and becomes a private stable object. */
export async function uploadWorkingDraftAttachment(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  clientKey: string;
  kind: "attachment" | "inline-image";
  filename: string;
  mimeType: string;
  disposition?: string;
  cid?: string;
  bytes: Blob;
}): Promise<WorkingDraftAttachmentReference> {
  if (!isUuid(input.draftId) || !input.clientKey || input.clientKey.length > 255) {
    throw new Error("INVALID_ATTACHMENT_UPLOAD");
  }
  const size = input.bytes.size;
  if (!Number.isSafeInteger(size) || size <= 0 || size > WORKING_DRAFT_MAX_ATTACHMENT_BYTES) {
    throw new Error("ATTACHMENT_LIMIT_EXCEEDED");
  }
  const client = db();
  const { data: previous, error: previousError } = await client
    .from("mail_working_draft_attachments")
    .select("*")
    .eq("draft_id", input.draftId)
    .eq("company_id", input.auth.companyId)
    .eq("account_id", input.auth.accountId)
    .eq("client_key", input.clientKey)
    .maybeSingle();
  if (previousError) throw new Error("ATTACHMENT_LOOKUP_FAILED");
  if (previous?.storage_path) {
    const row = previous as AttachmentRow;
    return {
      attachmentId: row.id,
      clientKey: row.client_key,
      kind: row.kind,
      filename: row.filename,
      mimeType: row.mime_type,
      size: Number(row.size_bytes),
      disposition: row.disposition ?? undefined,
      cid: row.cid ?? undefined,
    };
  }
  if (previous) throw new Error("ATTACHMENT_CLIENT_KEY_CONFLICT");

  const attachmentId = randomUUID();
  const storagePath = attachmentStoragePath(input.auth, input.draftId, attachmentId);
  const uploaded = await client.storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).upload(storagePath, input.bytes, {
    contentType: input.mimeType || "application/octet-stream",
    upsert: false,
  });
  if (uploaded.error) throw new Error("ATTACHMENT_UPLOAD_FAILED");
  const { data: createdId, error } = await client.rpc(
    "create_mail_working_draft_attachment",
    {
      p_draft_id: input.draftId,
      p_company_id: input.auth.companyId,
      p_account_id: input.auth.accountId,
      p_attachment_id: attachmentId,
      p_client_key: input.clientKey,
      p_kind: input.kind,
      p_filename: input.filename,
      p_mime_type: input.mimeType || "application/octet-stream",
      p_size_bytes: size,
      p_disposition: input.disposition ?? null,
      p_cid: input.cid ?? null,
      p_storage_path: storagePath,
      p_source_descriptor: null,
      p_payload: emptyWorkingDraftPayload(),
    },
  );
  if (error || createdId !== attachmentId) {
    await client.storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).remove([storagePath]);
    if (isDraftDiscardedRpcError(error)) throw new Error("DRAFT_DISCARDED");
    throw new Error("ATTACHMENT_RECORD_CREATE_FAILED");
  }
  return {
    attachmentId,
    clientKey: input.clientKey,
    kind: input.kind,
    filename: input.filename,
    mimeType: input.mimeType || "application/octet-stream",
    size,
    disposition: input.disposition,
    cid: input.cid,
  };
}

async function resolveBridgeForWorkingDraft(auth: WorkingDraftAuth) {
  const { resolveBridgeAuthForVerifiedClaims } = await import("@/lib/mail-bridge-auth.server");
  const bridge = await resolveBridgeAuthForVerifiedClaims({ sub: auth.accountId, cid: auth.companyId });
  if (!bridge.ok) throw new Error(bridge.code);
  const { loadDecryptedPasswordForAccount } = await import("@/lib/mail-credentials.server");
  const password = await loadDecryptedPasswordForAccount(supabaseAdmin, auth.accountId, auth.companyId);
  return { bridge, password };
}

type WorkingDraftTransferContext = Awaited<ReturnType<typeof resolveBridgeForWorkingDraft>> & {
  client: UntypedDb;
};

async function createWorkingDraftTransferContext(
  auth: WorkingDraftAuth,
): Promise<WorkingDraftTransferContext> {
  const resolved = await resolveBridgeForWorkingDraft(auth);
  return { ...resolved, client: db() };
}

/**
 * Reconcile the stable checkpoint revision before importing an external
 * provider source or reading/staging any attachment object. A response lost
 * after a successful IMAP APPEND is therefore recovered without touching an
 * obsolete UID or retransferring bytes.
 */
async function reconcileWorkingDraftRevision(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  revisionId: string;
  context?: WorkingDraftTransferContext;
}): Promise<{ found: boolean; serverRef: DraftServerRef | null }> {
  const { bridge, password } =
    input.context ?? (await createWorkingDraftTransferContext(input.auth));
  const response = await fetch(`${bridge.bridgeUrl}/api/draft-revision-reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Key": bridge.bridgeKey },
    body: JSON.stringify({
      account: bridge.bridgeAccount,
      password,
      draftId: input.draftId,
      revisionId: input.revisionId,
    }),
  });
  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !result?.ok || typeof result.found !== "boolean") {
    throw new Error("CHECKPOINT_RECONCILIATION_FAILED");
  }
  const serverRef =
    typeof result.folderPath === "string" &&
    Number.isSafeInteger(result.uid) &&
    Number(result.uid) > 0 &&
    typeof result.uidValidity === "string"
      ? { folderPath: result.folderPath, uid: Number(result.uid), uidValidity: result.uidValidity }
      : null;
  return { found: result.found, serverRef };
}

const externalImportFlights = new Map<string, Promise<AttachmentRow>>();

function sourceOf(row: AttachmentRow): WorkingDraftSourceDescriptor | null {
  const source = row.source_descriptor;
  if (!source || typeof source !== "object") return null;
  const value = source as Record<string, unknown>;
  return typeof value.folderPath === "string" &&
    Number.isSafeInteger(value.uid) &&
    Number(value.uid) > 0 &&
    typeof value.uidValidity === "string" &&
    typeof value.part === "string" &&
    /^\d+(?:\.\d+)*$/.test(value.part)
    ? { folderPath: value.folderPath, uid: Number(value.uid), uidValidity: value.uidValidity, part: value.part }
    : null;
}

/** Imports an external provider attachment exactly once per process flight, into its stable object path. */
async function importExternalAttachment(
  auth: WorkingDraftAuth,
  row: AttachmentRow,
  context?: WorkingDraftTransferContext,
): Promise<AttachmentRow> {
  if (row.storage_path) return row;
  const key = `${auth.companyId}:${auth.accountId}:${row.draft_id}:${row.id}`;
  const existing = externalImportFlights.get(key);
  if (existing) return existing;
  const flight = (async () => {
    const source = sourceOf(row);
    if (!source) throw new Error("SOURCE_DESCRIPTOR_INVALID");
    const transfer = context ?? (await createWorkingDraftTransferContext(auth));
    const { bridge, password, client } = transfer;
    const response = await fetch(`${bridge.bridgeUrl}/api/draft-source-attachment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Key": bridge.bridgeKey },
      body: JSON.stringify({
        account: bridge.bridgeAccount,
        password,
        ...source,
        filename: row.filename,
        mimeType: row.mime_type,
        size: row.size_bytes,
        kind: row.kind,
      }),
    });
    if (!response.ok) throw new Error("SOURCE_ATTACHMENT_IMPORT_FAILED");
    const bytes = await response.blob();
    if (bytes.size > WORKING_DRAFT_MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_LIMIT_EXCEEDED");
    const storagePath = attachmentStoragePath(auth, row.draft_id, row.id);
    const uploaded = await client.storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).upload(storagePath, bytes, {
      contentType: row.mime_type,
      upsert: false,
    });
    if (uploaded.error && !/exists|duplicate/i.test(String(uploaded.error.message ?? ""))) {
      throw new Error("SOURCE_ATTACHMENT_STORE_FAILED");
    }
    const { data, error } = await client
      .from("mail_working_draft_attachments")
      .update({
        storage_path: storagePath,
        source_descriptor: null,
        size_bytes: bytes.size,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("draft_id", row.draft_id)
      .eq("company_id", auth.companyId)
      .eq("account_id", auth.accountId)
      .select("*")
      .maybeSingle();
    if (error || !data) throw new Error("SOURCE_ATTACHMENT_IMPORT_COMMIT_FAILED");
    return data as AttachmentRow;
  })().finally(() => externalImportFlights.delete(key));
  externalImportFlights.set(key, flight);
  return flight;
}

async function stageOwnedAttachment(
  context: WorkingDraftTransferContext,
  row: AttachmentRow,
): Promise<string> {
  if (!row.storage_path) throw new Error("ATTACHMENT_NOT_IMPORTED");
  const { bridge, client } = context;
  const downloaded = await client.storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).download(row.storage_path);
  if (downloaded.error || !downloaded.data) throw new Error("ATTACHMENT_STORAGE_READ_FAILED");
  const bytes = downloaded.data as Blob;
  const ticketResponse = await fetch(`${bridge.bridgeUrl}/api/attachment-upload-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Key": bridge.bridgeKey },
    body: JSON.stringify({
      account: bridge.bridgeAccount,
      filename: row.filename,
      size: bytes.size,
      mimeType: row.mime_type,
      kind: row.kind,
    }),
  });
  const ticket = (await ticketResponse.json().catch(() => null)) as
    | { ok?: boolean; uploadUrl?: string; ticket?: string }
    | null;
  if (!ticketResponse.ok || !ticket?.ok || !ticket.uploadUrl || !ticket.ticket) {
    throw new Error("CHECKPOINT_STAGE_TICKET_FAILED");
  }
  const staged = await fetch(ticket.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ticket.ticket}`,
      "Content-Type": row.mime_type,
    },
    body: bytes,
  });
  const result = (await staged.json().catch(() => null)) as { ok?: boolean; handle?: string } | null;
  if (!staged.ok || !result?.ok || !result.handle) throw new Error("CHECKPOINT_STAGE_UPLOAD_FAILED");
  return result.handle;
}

async function materializePayloadAttachments(
  auth: WorkingDraftAuth,
  draftId: string,
  payload: WorkingDraftPayload,
  context: WorkingDraftTransferContext,
): Promise<AttachmentRow[]> {
  await syncAttachmentReferences(auth, draftId, payload.attachments);
  const rows = await attachmentRows(auth, draftId);
  const byClientKey = new Map(rows.map((row) => [row.client_key, row]));
  return mapWithBoundedConcurrency(
    payload.attachments,
    WORKING_DRAFT_STAGE_CONCURRENCY,
    async (reference) => {
    const row = reference.attachmentId
      ? rows.find((candidate) => candidate.id === reference.attachmentId)
      : byClientKey.get(reference.clientKey);
    if (!row) throw new Error("ATTACHMENT_REFERENCE_MISSING");
    return row.storage_path ? row : importExternalAttachment(auth, row, context);
    },
  );
}

export interface SendSourceAttachment {
  folderPath: string;
  uid: number;
  uidValidity: string;
  part: string;
  filename: string;
  size: number;
  mimeType: string;
}

/**
 * Send-time attachment plan.
 *
 * A kept provider attachment that was never imported is handed to the Bridge
 * as an IMAP source descriptor instead of being pulled through the App server
 * (IMAP -> Worker -> Storage -> Worker -> Bridge). The Bridge streams those
 * bytes straight from IMAP into the outgoing MIME, so Send drops two full
 * byte hops per attachment. Owned objects and inline images keep the existing
 * staged-object path unchanged.
 */
async function resolveSendAttachments(
  auth: WorkingDraftAuth,
  draftId: string,
  payload: WorkingDraftPayload,
  context: WorkingDraftTransferContext,
): Promise<{ rows: AttachmentRow[]; sources: SendSourceAttachment[] }> {
  await syncAttachmentReferences(auth, draftId, payload.attachments);
  const rows = await attachmentRows(auth, draftId);
  const byClientKey = new Map(rows.map((row) => [row.client_key, row]));
  const resolved = await mapWithBoundedConcurrency(
    payload.attachments,
    WORKING_DRAFT_STAGE_CONCURRENCY,
    async (reference) => {
      const row = reference.attachmentId
        ? rows.find((candidate) => candidate.id === reference.attachmentId)
        : byClientKey.get(reference.clientKey);
      if (!row) throw new Error("ATTACHMENT_REFERENCE_MISSING");
      if (row.storage_path) return { owned: row, source: null };
      const source = sourceOf(row);
      if (row.kind === "attachment" && source) {
        return {
          owned: null,
          source: {
            ...source,
            filename: row.filename,
            size: Number(row.size_bytes) || 0,
            mimeType: row.mime_type,
          } satisfies SendSourceAttachment,
        };
      }
      return { owned: await importExternalAttachment(auth, row, context), source: null };
    },
  );
  return {
    rows: resolved.flatMap((item) => (item.owned ? [item.owned] : [])),
    sources: resolved.flatMap((item) => (item.source ? [item.source] : [])),
  };
}

async function getWorkingDraftSendState(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<string | null> {
  const { data, error } = await db()
    .from("mail_working_draft_sends")
    .select("state")
    .eq("draft_id", draftId)
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .maybeSingle();
  if (error || !data) return null;
  return typeof data.state === "string" ? data.state : null;
}

async function isDraftDiscarded(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<boolean> {
  const { data, error } = await db()
    .from("mail_working_draft_discards")
    .select("id")
    .eq("draft_id", draftId)
    .eq("company_id", auth.companyId)
    .eq("account_id", auth.accountId)
    .maybeSingle();
  return !error && Boolean(data);
}

async function ensureDraftNotDiscarded(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<void> {
  if (await isDraftDiscarded(auth, draftId)) {
    throw new Error("DRAFT_DISCARDED");
  }
}

function isDraftDiscardedRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown; details?: unknown };
  return (
    value.code === "23514" ||
    value.code === "DRAFT_DISCARDED" ||
    String(value.message ?? "").includes("DRAFT_DISCARDED") ||
    String(value.details ?? "").includes("DRAFT_DISCARDED")
  );
}

async function finishWorkingDraftCheckpointIfActive(
  auth: WorkingDraftAuth,
  draftId: string,
  checkpointRevision: number,
  success: boolean,
  serverRef: DraftServerRef | null,
  error: string | null,
): Promise<{ committed: boolean; fenced: boolean; sendState: string }> {
  const { data, error: rpcError } = await db().rpc(
    "finish_mail_working_draft_checkpoint_if_active",
    {
      p_draft_id: draftId,
      p_company_id: auth.companyId,
      p_account_id: auth.accountId,
      p_checkpoint_revision: checkpointRevision,
      p_success: success,
      p_server_ref: serverRef,
      p_error: error,
    },
  );
  if (rpcError) throw new Error("CHECKPOINT_ATOMIC_FINALIZE_FAILED");
  const row = Array.isArray(data) ? data[0] : null;
  return {
    committed: row?.committed === true,
    fenced: row?.fenced === true,
    sendState: typeof row?.send_state === "string" ? row.send_state : "unknown",
  };
}

function recipients(items: unknown): Array<{ name: string; email: string }> {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    return value.valid !== false && typeof value.email === "string"
      ? [{ name: typeof value.name === "string" ? value.name : "", email: value.email }]
      : [];
  });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function invokeBridgeWithStagedAttachments(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  revisionId: string;
  payload: WorkingDraftPayload;
  rows: readonly AttachmentRow[];
  /** Provider attachments streamed by the Bridge straight from IMAP. */
  sourceAttachments?: readonly SendSourceAttachment[];
  endpoint: "/api/draft-save-v2" | "/api/send-v2";
  previousRef?: DraftServerRef | null;
  context: WorkingDraftTransferContext;
}): Promise<Record<string, unknown>> {
  const { bridge, password } = input.context;
  const stagedHandles: string[] = [];
  const handles = new Array<string | undefined>(input.rows.length);
  try {
    await mapWithBoundedConcurrency(
      input.rows,
      WORKING_DRAFT_STAGE_CONCURRENCY,
      async (row, index) => {
      const handle = await stageOwnedAttachment(input.context, row);
      handles[index] = handle;
      stagedHandles.push(handle);
      },
    );
    const normal: string[] = [];
    const inline: Array<{ handle: string; uploadFilename: string; cid: string; contentType: string }> = [];
    input.rows.forEach((row, index) => {
      if (row.kind === "attachment") normal.push(handles[index]!);
      else {
        if (!row.cid) throw new Error("INLINE_CID_REQUIRED");
        inline.push({
          handle: handles[index]!,
          uploadFilename: row.filename,
          cid: row.cid,
          contentType: row.mime_type,
        });
      }
    });
    const snapshot = input.payload.snapshot;
    const response = await fetch(`${bridge.bridgeUrl}${input.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Key": bridge.bridgeKey },
      body: JSON.stringify({
        account: bridge.bridgeAccount,
        password,
        draftId: input.draftId,
        revisionId: input.revisionId,
        to: recipients(snapshot.to),
        cc: recipients(snapshot.cc),
        bcc: recipients(snapshot.bcc),
        subject: snapshot.subject || " ",
        inReplyTo: snapshot.inReplyTo,
        references: snapshot.references ?? [],
        bodyHtml: snapshot.html,
        bodyText: stripHtml(snapshot.html),
        previousRef: input.previousRef ?? undefined,
        attachmentHandles: normal,
        stagedInlineImages: inline,
        sourceAttachments: input.sourceAttachments ?? [],
        sourceInlineImages: [],
      }),
    });
    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      if (isDefinitePreSmtpSendError(result?.error)) {
        throw new DraftSendRejectedError("BRIDGE_DRAFT_TRANSFER_FAILED");
      }
      throw new Error("BRIDGE_DRAFT_TRANSFER_AMBIGUOUS");
    }
    if (!result?.ok) {
      if (result && result.ok === false) {
        if (isDefinitePreSmtpSendError(result.error)) {
          throw new DraftSendRejectedError("BRIDGE_DRAFT_TRANSFER_FAILED");
        }
        throw new Error("BRIDGE_DRAFT_TRANSFER_AMBIGUOUS");
      }
      throw new Error("BRIDGE_DRAFT_TRANSFER_RESPONSE_MISSING");
    }
    return result;
  } finally {
    // Bridge staging is only a transient hand-off to the downstream provider.
    // The durable Supabase object stays authoritative for the next checkpoint
    // or send, so a successful checkpoint must not retain a 24-hour copy.
    if (stagedHandles.length > 0) {
      await fetch(`${bridge.bridgeUrl}/api/staged-release`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": bridge.bridgeKey },
        body: JSON.stringify({ account: bridge.bridgeAccount, handles: stagedHandles }),
      }).catch(() => undefined);
    }
  }
}

export async function checkpointWorkingDraft(input: {
  auth: WorkingDraftAuth;
  draftId: string;
}): Promise<
  | {
      ok: true;
      skipped?: boolean;
      fenced?: boolean;
      revision?: number;
      serverRef?: DraftServerRef | null;
    }
  | { ok: false; code: string }
> {
  const record = await loadWorkingDraft(input.auth, input.draftId);
  if (!record) return { ok: true, skipped: true };
  if (record.checkpoint.committedRevision >= record.revision) return { ok: true, skipped: true };
  const claim = await db().rpc("claim_mail_working_draft_checkpoint", {
    p_draft_id: input.draftId,
    p_company_id: input.auth.companyId,
    p_account_id: input.auth.accountId,
    p_revision: record.revision,
  });
  if (claim.error) return { ok: false, code: "CHECKPOINT_CLAIM_FAILED" };
  const claimed = Array.isArray(claim.data) ? claim.data[0] : null;
  if (!claimed?.claimed || !isUuid(claimed.revision_id)) return { ok: true, skipped: true };
  try {
    // DELETE-vs-CHECKPOINT fence: before any expensive provider reconciliation,
    // materialization, or APPEND, the row must still exist. If explicit delete
    // already won, stop here without creating a provider copy.
    if (!(await loadWorkingDraft(input.auth, input.draftId))) {
      return { ok: true, skipped: true };
    }

    const preSendState = await getWorkingDraftSendState(input.auth, input.draftId);
    if (isDraftProviderCheckpointFenced(preSendState)) {
      return { ok: true, skipped: true, fenced: true };
    }

    const transferContext = await createWorkingDraftTransferContext(input.auth);
    const reconciliation = await reconcileWorkingDraftRevision({
      auth: input.auth,
      draftId: input.draftId,
      revisionId: claimed.revision_id,
      context: transferContext,
    });
    if (reconciliation.found) {
      if (!(await loadWorkingDraft(input.auth, input.draftId))) {
        await deleteProviderDraftExplicit({
          auth: input.auth,
          draftId: input.draftId,
          previousRef: reconciliation.serverRef,
        }).catch(() => undefined);
        return { ok: true, skipped: true };
      }
      const reconciliationFinalize = await finishWorkingDraftCheckpointIfActive(
        input.auth,
        input.draftId,
        record.revision,
        true,
        reconciliation.serverRef,
        null,
      );
      if (reconciliationFinalize.fenced) {
        await deleteProviderDraftExplicit({
          auth: input.auth,
          draftId: input.draftId,
          previousRef: reconciliation.serverRef,
        }).catch(() => undefined);
        return { ok: true, skipped: true, fenced: true };
      }
      if (!reconciliationFinalize.committed) {
        return { ok: true, skipped: true };
      }
      if (!(await loadWorkingDraft(input.auth, input.draftId))) {
        await deleteProviderDraftExplicit({
          auth: input.auth,
          draftId: input.draftId,
          previousRef: reconciliation.serverRef,
        }).catch(() => undefined);
        return { ok: true, skipped: true };
      }
      return { ok: true, revision: record.revision, serverRef: reconciliation.serverRef };
    }
    const rows = await materializePayloadAttachments(
      input.auth,
      input.draftId,
      record.payload,
      transferContext,
    );
    const result = await invokeBridgeWithStagedAttachments({
      auth: input.auth,
      draftId: input.draftId,
      revisionId: claimed.revision_id,
      payload: record.payload,
      rows,
      endpoint: "/api/draft-save-v2",
      previousRef: record.checkpoint.serverRef,
      context: transferContext,
    });
    const serverRef =
      typeof result.folderPath === "string" &&
      Number.isSafeInteger(result.uid) &&
      Number(result.uid) > 0 &&
      typeof result.uidValidity === "string"
        ? { folderPath: result.folderPath, uid: Number(result.uid), uidValidity: result.uidValidity }
        : null;
    if (!(await loadWorkingDraft(input.auth, input.draftId))) {
      await deleteProviderDraftExplicit({
        auth: input.auth,
        draftId: input.draftId,
        previousRef: serverRef,
      }).catch(() => undefined);
      return { ok: true, skipped: true };
    }
    const finalize = await finishWorkingDraftCheckpointIfActive(
      input.auth,
      input.draftId,
      record.revision,
      true,
      serverRef,
      null,
    );
    if (finalize.fenced) {
      await deleteProviderDraftExplicit({
        auth: input.auth,
        draftId: input.draftId,
        previousRef: serverRef,
      }).catch(() => undefined);
      return { ok: true, skipped: true, fenced: true };
    }
    if (!finalize.committed) {
      if (
        serverRef &&
        (!record.checkpoint.serverRef ||
          serverRef.uid !== record.checkpoint.serverRef.uid ||
          serverRef.uidValidity !== record.checkpoint.serverRef.uidValidity)
      ) {
        await deleteProviderDraftExplicit({
          auth: input.auth,
          draftId: input.draftId,
          previousRef: serverRef,
        }).catch(() => undefined);
      }
      return { ok: true, skipped: true };
    }
    if (!(await loadWorkingDraft(input.auth, input.draftId))) {
      await deleteProviderDraftExplicit({
        auth: input.auth,
        draftId: input.draftId,
        previousRef: serverRef,
      }).catch(() => undefined);
      return { ok: true, skipped: true };
    }
    return { ok: true, revision: record.revision, serverRef };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : "CHECKPOINT_FAILED";
    if (await loadWorkingDraft(input.auth, input.draftId)) {
      await db().rpc("finish_mail_working_draft_checkpoint", {
        p_draft_id: input.draftId,
        p_company_id: input.auth.companyId,
        p_account_id: input.auth.accountId,
        p_checkpoint_revision: record.revision,
        p_success: false,
        p_server_ref: null,
        p_error: code,
      });
    }
    return { ok: false, code };
  }
}

export async function deleteWorkingDraft(input: {
  auth: WorkingDraftAuth;
  draftId: string;
}): Promise<{ deleted: boolean; serverRef: DraftServerRef | null }> {
  const record = await loadWorkingDraft(input.auth, input.draftId);
  if (!record) return { deleted: false, serverRef: null };
  const rows = await attachmentRows(input.auth, input.draftId);
  const { error } = await db()
    .from("mail_working_drafts")
    .delete()
    .eq("id", input.draftId)
    .eq("company_id", input.auth.companyId)
    .eq("account_id", input.auth.accountId);
  if (error) throw new Error("WORKING_DRAFT_DELETE_FAILED");
  const paths = rows.flatMap((row) => (row.storage_path ? [row.storage_path] : []));
  if (paths.length > 0) await db().storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).remove(paths);
  return { deleted: true, serverRef: record.checkpoint.serverRef };
}

/**
 * Durable, non-blocking discard fence. Provider cleanup is retried separately;
 * the composer may close as soon as this RPC acknowledges the tombstone.
 */
export async function discardWorkingDraft(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  serverRef?: DraftServerRef | null;
  previousRef?: DraftServerRef | null;
}): Promise<{ ok: true }> {
  if (!isUuid(input.draftId)) throw new Error("INVALID_DRAFT_ID");
  const { error } = await db().rpc("discard_mail_working_draft", {
    p_draft_id: input.draftId,
    p_company_id: input.auth.companyId,
    p_account_id: input.auth.accountId,
    p_server_ref: input.serverRef ?? null,
    p_previous_ref: input.previousRef ?? null,
  });
  if (error) throw new Error("DISCARD_WORKING_DRAFT_FAILED");
  trackCloudflareWork(startDiscardedCleanup(input.auth, input.draftId));
  return { ok: true };
}

/**
 * Explicit-user-delete path. Provider deletion is AWAITED and verified before
 * the durable Working Draft row/objects are removed, so a failed provider
 * delete leaves the row in place for retry instead of silently losing the
 * only recoverable copy. Provider-only Drafts are handled even when no
 * Working Draft row exists.
 */
export async function deleteWorkingDraftExplicit(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  previousRef?: DraftServerRef | null;
}): Promise<{ deleted: boolean; serverRef: DraftServerRef | null }> {
  if (!isUuid(input.draftId)) throw new Error("INVALID_DRAFT_ID");
  const record = await loadWorkingDraft(input.auth, input.draftId);
  const providerRef = record?.checkpoint.serverRef ?? input.previousRef ?? null;
  const providerDelete = await deleteProviderDraftExplicit({
    auth: input.auth,
    draftId: input.draftId,
    previousRef: providerRef,
  });
  if (!providerDelete.ok) throw new Error("PROVIDER_DRAFT_DELETE_FAILED");

  if (!record) {
    // Provider-only/legacy Draft: no Working Draft row exists, but the
    // provider delete succeeded (or confirmed no copy). This is idempotent.
    return { deleted: true, serverRef: providerRef };
  }

  const rows = await attachmentRows(input.auth, input.draftId);
  const { error } = await db()
    .from("mail_working_drafts")
    .delete()
    .eq("id", input.draftId)
    .eq("company_id", input.auth.companyId)
    .eq("account_id", input.auth.accountId);
  if (error) throw new Error("WORKING_DRAFT_DELETE_FAILED");
  const paths = rows.flatMap((row) => (row.storage_path ? [row.storage_path] : []));
  if (paths.length > 0) await db().storage.from(WORKING_DRAFT_ATTACHMENT_BUCKET).remove(paths);
  return { deleted: true, serverRef: record.checkpoint.serverRef };
}

async function claimWorkingDraftSend(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<WorkingDraftSendClaim> {
  if (!isUuid(draftId)) throw new Error("INVALID_DRAFT_ID");
  const { data, error } = await db().rpc("claim_mail_working_draft_send", {
    p_draft_id: draftId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
  });
  if (error) throw new Error("SEND_IDEMPOTENCY_CLAIM_FAILED");
  const claim = sendClaimFromRpc(data);
  if (!claim) throw new Error("SEND_IDEMPOTENCY_INVALID_REPLY");
  return claim;
}

async function markWorkingDraftSendSent(
  auth: WorkingDraftAuth,
  draftId: string,
  smtpResult: Record<string, unknown>,
): Promise<void> {
  const { error } = await db().rpc("mark_mail_working_draft_send_sent", {
    p_draft_id: draftId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_result: smtpResult,
  });
  if (error) throw new Error("SEND_IDEMPOTENCY_COMMIT_FAILED");
}

async function markWorkingDraftSendInFlight(
  auth: WorkingDraftAuth,
  draftId: string,
): Promise<void> {
  const { data, error } = await db().rpc("mark_mail_working_draft_send_in_flight", {
    p_draft_id: draftId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
  });
  if (error || data !== true) throw new Error("SEND_CLAIM_LOST");
}

async function markWorkingDraftSendFailed(
  auth: WorkingDraftAuth,
  draftId: string,
  reason: string,
): Promise<void> {
  const { error } = await db().rpc("mark_mail_working_draft_send_failed", {
    p_draft_id: draftId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_error: reason.slice(0, 120),
  });
  if (error) throw new Error("SEND_IDEMPOTENCY_FAILURE_COMMIT_FAILED");
}

async function deleteProviderDraftExplicit(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  previousRef: DraftServerRef | null;
}): Promise<{ ok: boolean; deleted: boolean; code?: string }> {
  const { bridge, password } = await resolveBridgeForWorkingDraft(input.auth);
  const response = await fetch(`${bridge.bridgeUrl}/api/draft-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Key": bridge.bridgeKey },
    body: JSON.stringify({
      account: bridge.bridgeAccount,
      password,
      draftId: input.draftId,
      previousRef: input.previousRef ?? undefined,
    }),
  });
  const result = (await response.json().catch(() => null)) as
    | { ok?: boolean; deleted?: boolean; error?: string }
    | null;
  if (!response.ok || !result?.ok) {
    return { ok: false, deleted: false, code: result?.error || "PROVIDER_DRAFT_DELETE_FAILED" };
  }
  return { ok: true, deleted: result.deleted === true };
}

/** Best-effort downstream cleanup; a failed provider delete never resurrects a deleted working Draft. */
export async function deleteProviderDraftCheckpoint(input: {
  auth: WorkingDraftAuth;
  draftId: string;
  previousRef: DraftServerRef | null;
}): Promise<void> {
  try {
    await deleteProviderDraftExplicit(input);
  } catch {
    // The server-side row is already deleted; normal provider reconciliation
    // can remove a stale interoperability copy later.
  }
}

/** Draft-origin send only. Normal compose send continues to use /api/mail-send-v2 unchanged. */
export async function sendWorkingDraft(input: {
  auth: WorkingDraftAuth;
  draftId: string;
}): Promise<Record<string, unknown>> {
  const claim = await claimWorkingDraftSend(input.auth, input.draftId);
  if (claim.state === "sent") {
    // SMTP already accepted this logical Draft. Return the stored result
    // without touching SMTP, attachments, or provider cleanup again.
    return claim.smtpResult ?? { ok: true };
  }
  if (claim.state === "discarded") {
    throw new Error("DRAFT_DISCARDED");
  }
  if (!claim.claimed) {
    throw new Error("SEND_IN_PROGRESS");
  }

  const record = await loadWorkingDraft(input.auth, input.draftId);
  if (!record) {
    await markWorkingDraftSendFailed(input.auth, input.draftId, "WORKING_DRAFT_NOT_FOUND").catch(
      () => undefined,
    );
    throw new Error("WORKING_DRAFT_NOT_FOUND");
  }

  let rows: Awaited<ReturnType<typeof materializePayloadAttachments>>;
  let transferContext: WorkingDraftTransferContext | null = null;
  try {
    transferContext = await createWorkingDraftTransferContext(input.auth);
    rows = await materializePayloadAttachments(
      input.auth,
      input.draftId,
      record.payload,
      transferContext,
    );
  } catch (error) {
    await markWorkingDraftSendFailed(
      input.auth,
      input.draftId,
      error instanceof Error ? error.message : "ATTACHMENT_MATERIALIZATION_FAILED",
    ).catch(() => undefined);
    throw error;
  }

  let result: Record<string, unknown>;
  try {
    await ensureDraftNotDiscarded(input.auth, input.draftId);
    await markWorkingDraftSendInFlight(input.auth, input.draftId);
    result = await invokeBridgeWithStagedAttachments({
      auth: input.auth,
      draftId: input.draftId,
      revisionId: randomUUID(),
      payload: record.payload,
      rows,
      endpoint: "/api/send-v2",
      context: transferContext!,
    });
    await markWorkingDraftSendSent(input.auth, input.draftId, result);
  } catch (error) {
    if (error instanceof DraftSendRejectedError) {
      await markWorkingDraftSendFailed(
        input.auth,
        input.draftId,
        error instanceof Error ? error.message : "SEND_FAILED",
      ).catch(() => undefined);
    }
    throw error;
  }

  // Provider cleanup is after durable sent and never blocks the Send response.
  // The Working Draft row remains durable until cleanup succeeds, and the
  // Draft list query hides sent rows, so a delayed/failed cleanup cannot
  // resurrect the Draft or block the UI.
  const cleanup = (async () => {
    try {
      await deleteWorkingDraftExplicit({
        auth: input.auth,
        draftId: input.draftId,
        previousRef: record.checkpoint.serverRef ?? null,
      });
    } catch {
      // The row remains for later reconciliation; do not reopen SMTP.
    }
  })();
  trackCloudflareWork(cleanup);
  return result;
}

export { isAuthError };
