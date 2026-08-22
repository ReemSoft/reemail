import type { DraftServerRef, DraftSnapshot } from "@/lib/mail-draft-lifecycle";

/**
 * Shared Draft-only wire contracts for the MailMaestro working-document
 * backend. Attachment bytes are deliberately absent from this module: the
 * browser sends a file only to the dedicated private upload endpoint once.
 */

export const WORKING_DRAFT_ATTACHMENT_BUCKET = "mail-draft-attachments";
export const WORKING_DRAFT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Transport contract: at most 10 normal attachments + 50 inline images.
export const WORKING_DRAFT_MAX_ATTACHMENTS = 60;

export type WorkingDraftAttachmentKind = "attachment" | "inline-image";

export interface WorkingDraftSourceDescriptor {
  folderPath: string;
  uid: number;
  uidValidity: string;
  part: string;
}

export interface WorkingDraftAttachmentReference {
  /** Stable private-object id returned by the upload endpoint, when owned. */
  attachmentId?: string;
  /** Stable per-draft key. It is never derived from filename or MIME type. */
  clientKey: string;
  kind: WorkingDraftAttachmentKind;
  filename: string;
  mimeType: string;
  size: number;
  disposition?: string;
  cid?: string;
  /** Existing provider data stays metadata-only until an import is required. */
  source?: WorkingDraftSourceDescriptor;
}

export interface WorkingDraftPayload {
  version: 1;
  snapshot: DraftSnapshot;
  attachments: WorkingDraftAttachmentReference[];
}

export interface WorkingDraftCheckpoint {
  revision: number;
  state: "pending" | "running" | "checkpointed" | "failed";
  committedRevision: number;
  serverRef: DraftServerRef | null;
  error?: string | null;
}

export interface WorkingDraftRecord {
  draftId: string;
  revision: number;
  payload: WorkingDraftPayload;
  checkpoint: WorkingDraftCheckpoint;
  updatedAt: string;
}

export interface WorkingDraftSentRef {
  draftId: string;
  serverRef: DraftServerRef | null;
}

export interface WorkingDraftAttachmentContent {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  cid?: string;
  bytes: Blob;
}

export interface WorkingDraftOwnedAttachmentProjection {
  attachmentId: string;
  clientKey: string;
  kind: WorkingDraftAttachmentKind;
  filename: string;
  mimeType: string;
  size: number;
  disposition?: string;
  cid?: string;
  hasBytes: boolean;
}

/**
 * Add server-owned object ids only to the Draft-open projection. Provider
 * references deliberately stay id-less in the authoritative optimistic
 * payload, but once checkpoint/import has materialized their bytes the editor
 * needs the private object id to hydrate the matching CID after a reopen.
 */
export function projectOwnedWorkingDraftAttachments(
  record: WorkingDraftRecord,
  ownedAttachments: readonly WorkingDraftOwnedAttachmentProjection[],
): WorkingDraftRecord {
  const byId = new Map(ownedAttachments.map((item) => [item.attachmentId, item]));
  const byClientKey = new Map(ownedAttachments.map((item) => [item.clientKey, item]));
  const attachments = record.payload.attachments.map((reference) => {
    const owned = reference.attachmentId
      ? byId.get(reference.attachmentId)
      : byClientKey.get(reference.clientKey);
    if (!owned?.hasBytes || owned.kind !== reference.kind) return reference;
    return {
      ...reference,
      attachmentId: owned.attachmentId,
      filename: owned.filename,
      mimeType: owned.mimeType,
      size: owned.size,
      disposition: owned.disposition ?? reference.disposition,
      cid: owned.cid ?? reference.cid,
    };
  });
  return { ...record, payload: { ...record.payload, attachments } };
}

export function isWorkingDraftSourceDescriptor(value: unknown): value is WorkingDraftSourceDescriptor {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.folderPath === "string" &&
    source.folderPath.length > 0 &&
    source.folderPath.length <= 500 &&
    Number.isSafeInteger(source.uid) &&
    Number(source.uid) > 0 &&
    typeof source.uidValidity === "string" &&
    source.uidValidity.length > 0 &&
    source.uidValidity.length <= 64 &&
    typeof source.part === "string" &&
    /^\d+(?:\.\d+)*$/.test(source.part)
  );
}

export function isWorkingDraftAttachmentReference(
  value: unknown,
): value is WorkingDraftAttachmentReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const source = item.source;
  const hasOwnedId = typeof item.attachmentId === "string" && item.attachmentId.length > 0;
  const inlineIdentityIsValid =
    item.kind !== "inline-image" ||
    (typeof item.cid === "string" && item.cid.trim().length > 0 && item.cid.length <= 998);
  return (
    typeof item.clientKey === "string" &&
    item.clientKey.length > 0 &&
    item.clientKey.length <= 255 &&
    (item.kind === "attachment" || item.kind === "inline-image") &&
    typeof item.filename === "string" &&
    item.filename.length > 0 &&
    item.filename.length <= 255 &&
    typeof item.mimeType === "string" &&
    item.mimeType.length > 0 &&
    item.mimeType.length <= 255 &&
    Number.isSafeInteger(item.size) &&
    Number(item.size) >= 0 &&
    Number(item.size) <= WORKING_DRAFT_MAX_ATTACHMENT_BYTES &&
    (item.disposition === undefined || typeof item.disposition === "string") &&
    (item.cid === undefined || typeof item.cid === "string") &&
    inlineIdentityIsValid &&
    (hasOwnedId || isWorkingDraftSourceDescriptor(source))
  );
}

export function isWorkingDraftPayload(value: unknown): value is WorkingDraftPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1 || !payload.snapshot || !Array.isArray(payload.attachments)) return false;
  if (payload.attachments.length > WORKING_DRAFT_MAX_ATTACHMENTS) return false;
  const keys = new Set<string>();
  for (const attachment of payload.attachments) {
    if (!isWorkingDraftAttachmentReference(attachment)) return false;
    if (keys.has(attachment.clientKey)) return false;
    keys.add(attachment.clientKey);
  }
  return true;
}

export function emptyWorkingDraftPayload(): WorkingDraftPayload {
  return {
    version: 1,
    snapshot: {
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      html: "",
      showCc: false,
      showBcc: false,
    },
    attachments: [],
  };
}

/**
 * Draft-list projection guard: a provider Draft row with the same stable
 * logical draftId may still carry a stale physical UID after checkpoint
 * APPEND replaced the provider copy. The durable Working Draft checkpoint
 * serverRef is authoritative, so the stale provider row must be suppressed.
 */
export function isStaleProviderDraftRow(input: {
  draftIdHeader?: string;
  messageUid: number;
  messageUidValidity?: string;
  workingDraftRecords: readonly WorkingDraftRecord[];
}): boolean {
  if (!input.draftIdHeader || !Number.isSafeInteger(input.messageUid) || input.messageUid <= 0) {
    return false;
  }
  if (!input.messageUidValidity) return false;
  const record = input.workingDraftRecords.find((candidate) => candidate.draftId === input.draftIdHeader);
  const serverRef = record?.checkpoint.serverRef;
  if (!serverRef) return false;
  return serverRef.uid !== input.messageUid || serverRef.uidValidity !== input.messageUidValidity;
}

/** Resolve the stable logical Draft id for a provider UID/UIDVALIDITY pair. */
export function findWorkingDraftIdByServerRef(
  workingDraftRecords: readonly WorkingDraftRecord[],
  uidValidity: string,
  uid: number,
): string | null {
  if (!uidValidity || !Number.isSafeInteger(uid) || uid <= 0) return null;
  const record = workingDraftRecords.find(
    (candidate) =>
      candidate.checkpoint.serverRef?.uidValidity === uidValidity &&
      candidate.checkpoint.serverRef.uid === uid,
  );
  return record?.draftId ?? null;
}

/** Hide Working Draft rows whose Draft Send is durably marked sent. */
export function filterSentWorkingDraftRecords(
  records: readonly WorkingDraftRecord[],
  sentDraftIds: ReadonlySet<string>,
): WorkingDraftRecord[] {
  return records.filter((record) => !sentDraftIds.has(record.draftId));
}

/** Suppress a provider Draft row when its UID matches a durably-sent Draft ref. */
export function isSentProviderDraftRef(
  uidValidity: string | undefined,
  uid: number,
  sentDraftRefs: readonly WorkingDraftSentRef[],
): boolean {
  if (!uidValidity || !Number.isSafeInteger(uid) || uid <= 0) return false;
  return sentDraftRefs.some(
    (ref) => ref.serverRef?.uidValidity === uidValidity && ref.serverRef.uid === uid,
  );
}
