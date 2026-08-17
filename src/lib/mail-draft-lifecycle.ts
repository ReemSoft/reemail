/**
 * Draft lifecycle module — MAILMAESTRO_DRAFT_APPEND_R1 (M4-B).
 *
 * Client-side orchestration around the draft save/delete server paths.
 * This module is UI-agnostic and fully unit-testable: it never touches
 * React, `window`, or the network directly. Callers inject a `Storage`
 * (localStorage-shaped), a remote `saveRemote` / `deleteRemote` pair, and
 * observe state via callbacks.
 *
 * Contract (locked by src/lib/__tests__/mail-draft-lifecycle.test.ts):
 *
 *   * `draftId` is stable across every save/edit for one composer session
 *     and is generated exactly once (persisted in the v3 doc).
 *   * localStorage v3 shape is authoritative:
 *       { version: 3, draftId, snapshot, serverRef, updatedAt }
 *     A legacy v2 blob (no version, no draftId, no serverRef) is migrated
 *     on read: a fresh `draftId` is assigned, `serverRef` is null, and the
 *     v2 key is removed atomically after the v3 write succeeds.
 *   * Save is single-flight: while a save is in flight, a new save() call
 *     does NOT start a second concurrent request. Instead the newest
 *     snapshot is captured and a follow-up save runs once the in-flight
 *     one settles ("keep last edit" semantics).
 *   * Generation guards: every save carries a monotonically increasing
 *     sequence number. Only the LATEST issued sequence may mutate the
 *     `serverRef` / status. Stale responses are dropped silently.
 *   * Server ref is updated ONLY on ok=true. On error the composer stays
 *     dirty (status → "failed") — a local snapshot is never presented as a
 *     successful draft. Only the remote IMAP APPEND makes a draft "saved".
 *   * Pending-cleanup queue: when a post-send delete fails, the entry is
 *     persisted per-account and retried on the next composer open / next
 *     save flush. Successful entries are removed atomically.
 */

import type { DraftSaveTriggerDiagnostics } from "@/lib/mail-draft-save-diagnostics";

// ---------------------------------------------------------------- Types

export type DraftSaveStatus = "idle" | "saving" | "saved" | "failed";

export interface DraftRecipient {
  email: string;
  name?: string;
  valid: boolean;
}

/** Physical IMAP identity used only to restore unsaved source attachments. */
export interface DraftAttachmentSourceRef {
  folderPath: string;
  uid: number;
  uidValidity: string;
}

/** Metadata-only source attachment. Attachment bytes are never persisted. */
export interface DraftSourceAttachment {
  id: string;
  part?: string;
  filename: string;
  size: number;
  mimeType: string;
  disposition?: string;
  contentId?: string;
}

export interface DraftSnapshot {
  to: DraftRecipient[];
  cc: DraftRecipient[];
  bcc: DraftRecipient[];
  subject: string;
  html: string;
  showCc: boolean;
  showBcc: boolean;
  inReplyTo?: string;
  references?: string[];
  inlineImages?: Array<{
    id: string;
    cid: string;
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    filename: string;
    uploadFilename: string;
    workingAttachmentId?: string;
    stagedHandle?: string;
    stagedExpiresAt?: number;
  }>;
  stagedAttachments?: Array<{
    handle: string;
    filename: string;
    size: number;
    mimeType: string;
    expiresAt?: number;
  }>;
  sourceAttachments?: {
    sourceRef: DraftAttachmentSourceRef;
    attachments: DraftSourceAttachment[];
  };
}

export interface DraftServerRef {
  folderPath: string;
  uid: number;
  uidValidity: string;
}

export interface DraftDocV3 {
  version: 3;
  draftId: string;
  snapshot: DraftSnapshot;
  serverRef: DraftServerRef | null;
  updatedAt: number;
  recoveryKind?: "new" | "edit";
  localRevision?: number;
  remoteCommittedRevision?: number;
  remoteCommitConfirmed?: boolean;
  revisionId?: string;
}

/** v2 shape from before M4-B. No draftId, no serverRef. */
interface DraftDocV2 {
  to: DraftRecipient[];
  cc: DraftRecipient[];
  bcc: DraftRecipient[];
  subject: string;
  html: string;
  showCc?: boolean;
  showBcc?: boolean;
}

export interface SaveRemoteResult {
  ok: boolean;
  serverRef?: DraftServerRef;
  /** True when Bridge found this exact revision already committed. */
  reconciled?: boolean;
  /** Coarse error code from the bridge. Present only when ok=false. */
  code?: string;
}

export interface DeleteRemoteResult {
  ok: boolean;
  code?: string;
}

export interface DraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ---------------------------------------------------------------- Keys

export const DRAFT_V2_KEY_PREFIX = "mailmaestro:draft:v2:";
export const DRAFT_V3_KEY_PREFIX = "mailmaestro:draft:v3:";
export const DRAFT_V4_KEY_PREFIX = "mailmaestro:draft:v4:";
export const DRAFT_V4_ACTIVE_NEW_PREFIX = "mailmaestro:draft-active-new:v4:";
export const DRAFT_PENDING_DELETE_PREFIX = "mailmaestro:draft-pending-delete:v1:";

export function draftKeyV3(accountEmail: string): string {
  return `${DRAFT_V3_KEY_PREFIX}${accountEmail}`;
}
export function draftKeyV4(accountEmail: string, draftId: string): string {
  return `${DRAFT_V4_KEY_PREFIX}${encodeURIComponent(accountEmail)}:${draftId}`;
}
export function activeNewDraftKeyV4(accountEmail: string): string {
  return `${DRAFT_V4_ACTIVE_NEW_PREFIX}${encodeURIComponent(accountEmail)}`;
}
export function draftKeyV2(accountEmail: string): string {
  return `${DRAFT_V2_KEY_PREFIX}${accountEmail}`;
}
export function pendingDeleteKey(accountEmail: string): string {
  return `${DRAFT_PENDING_DELETE_PREFIX}${accountEmail}`;
}

// ---------------------------------------------------------------- ID

/**
 * Stable draftId generator. Uses crypto.randomUUID() everywhere modern
 * (Node 18+, all supported browsers). Tests may inject their own.
 */
export function newDraftId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------- Persistence

function emptySnapshotShape(v2: DraftDocV2): DraftSnapshot {
  return {
    to: Array.isArray(v2.to) ? v2.to : [],
    cc: Array.isArray(v2.cc) ? v2.cc : [],
    bcc: Array.isArray(v2.bcc) ? v2.bcc : [],
    subject: typeof v2.subject === "string" ? v2.subject : "",
    html: typeof v2.html === "string" ? v2.html : "",
    showCc: Boolean(v2.showCc ?? (Array.isArray(v2.cc) && v2.cc.length > 0)),
    showBcc: Boolean(v2.showBcc ?? (Array.isArray(v2.bcc) && v2.bcc.length > 0)),
  };
}

function isV3Doc(v: unknown): v is DraftDocV3 {
  if (!v || typeof v !== "object") return false;
  const d = v as Partial<DraftDocV3>;
  return (
    d.version === 3 &&
    typeof d.draftId === "string" &&
    d.draftId.length > 0 &&
    !!d.snapshot &&
    typeof d.snapshot === "object"
  );
}

function nonNegativeRevision(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

/** Legacy documents are conservatively unconfirmed so they can never restore false-clean. */
export function normalizeDraftRecoveryDoc(
  doc: DraftDocV3,
  recoveryKind: "new" | "edit" = doc.recoveryKind ?? "new",
): DraftDocV3 {
  const hasExplicitCommitMetadata =
    Number.isSafeInteger(doc.localRevision) &&
    Number.isSafeInteger(doc.remoteCommittedRevision) &&
    typeof doc.remoteCommitConfirmed === "boolean";
  if (!hasExplicitCommitMetadata) {
    return {
      ...doc,
      recoveryKind,
      localRevision: 1,
      remoteCommittedRevision: 0,
      remoteCommitConfirmed: false,
      revisionId: doc.revisionId || newDraftId(),
    };
  }
  const localRevision = nonNegativeRevision(doc.localRevision, 1);
  const remoteCommittedRevision = Math.min(
    localRevision,
    nonNegativeRevision(doc.remoteCommittedRevision, 0),
  );
  return {
    ...doc,
    recoveryKind,
    localRevision,
    remoteCommittedRevision,
    remoteCommitConfirmed:
      doc.remoteCommitConfirmed === true && localRevision === remoteCommittedRevision,
    revisionId: doc.revisionId || newDraftId(),
  };
}

function readV4DraftById(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
): DraftDocV3 | null {
  try {
    const raw = storage.getItem(draftKeyV4(accountEmail, draftId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isV3Doc(parsed) && parsed.draftId === draftId ? normalizeDraftRecoveryDoc(parsed) : null;
  } catch {
    return null;
  }
}

function writeV4Draft(
  storage: DraftStorageLike,
  accountEmail: string,
  doc: DraftDocV3,
  recoveryKind: "new" | "edit",
): boolean {
  try {
    const normalized = normalizeDraftRecoveryDoc({ ...doc, recoveryKind }, recoveryKind);
    storage.setItem(draftKeyV4(accountEmail, doc.draftId), JSON.stringify(normalized));
    if (recoveryKind === "new") {
      storage.setItem(activeNewDraftKeyV4(accountEmail), doc.draftId);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a draft document. On a legacy v2 blob, migrate atomically:
 *   1. Build a v3 doc with a fresh `draftId` and null `serverRef`.
 *   2. Write the v3 key.
 *   3. Remove the v2 key.
 * If ANY step throws, we return null so the composer starts clean rather
 * than crashing on hydrate.
 */
export function readDraftDoc(
  storage: DraftStorageLike,
  accountEmail: string,
  idFactory: () => string = newDraftId,
  now: () => number = () => Date.now(),
): DraftDocV3 | null {
  try {
    const activeDraftId = storage.getItem(activeNewDraftKeyV4(accountEmail));
    if (activeDraftId) {
      const active = readV4DraftById(storage, accountEmail, activeDraftId);
      if (active?.recoveryKind === "new") return active;
      storage.removeItem(activeNewDraftKeyV4(accountEmail));
    }
  } catch {
    /* fall through to legacy migration */
  }

  const v3Key = draftKeyV3(accountEmail);
  try {
    const rawV3 = storage.getItem(v3Key);
    if (rawV3) {
      const parsed: unknown = JSON.parse(rawV3);
      if (isV3Doc(parsed)) {
        const migrated = normalizeDraftRecoveryDoc(parsed, "new");
        if (!writeV4Draft(storage, accountEmail, migrated, "new")) return null;
        storage.removeItem(v3Key);
        return migrated;
      }
    }
  } catch {
    /* fall through to v2 attempt */
  }

  const v2Key = draftKeyV2(accountEmail);
  try {
    const rawV2 = storage.getItem(v2Key);
    if (!rawV2) return null;
    const parsed = JSON.parse(rawV2) as DraftDocV2;
    const doc: DraftDocV3 = {
      version: 3,
      draftId: idFactory(),
      snapshot: emptySnapshotShape(parsed),
      serverRef: null,
      updatedAt: now(),
      recoveryKind: "new",
      localRevision: 1,
      remoteCommittedRevision: 0,
      remoteCommitConfirmed: false,
      revisionId: idFactory(),
    };
    if (!writeV4Draft(storage, accountEmail, doc, "new")) return null;
    // Only remove v2 AFTER the Draft-scoped write succeeded.
    storage.removeItem(v2Key);
    return doc;
  } catch {
    return null;
  }
}

/** Read recovery owned by one provider Draft without touching another Draft. */
export function readDraftDocById(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
): DraftDocV3 | null {
  const scoped = readV4DraftById(storage, accountEmail, draftId);
  if (scoped) return scoped;
  try {
    const rawLegacy = storage.getItem(draftKeyV3(accountEmail));
    if (!rawLegacy) return null;
    const parsed: unknown = JSON.parse(rawLegacy);
    if (!isV3Doc(parsed) || parsed.draftId !== draftId) return null;
    const migrated = normalizeDraftRecoveryDoc(parsed, "edit");
    if (!writeV4Draft(storage, accountEmail, migrated, "edit")) return null;
    storage.removeItem(draftKeyV3(accountEmail));
    return migrated;
  } catch {
    return null;
  }
}

/** Write a v3 doc. Returns true when persisted, false on quota / IO. */
export function writeDraftDoc(
  storage: DraftStorageLike,
  accountEmail: string,
  doc: DraftDocV3,
  recoveryKind: "new" | "edit" = doc.recoveryKind ?? "new",
): boolean {
  return writeV4Draft(storage, accountEmail, doc, recoveryKind);
}

/**
 * Patch only the serverRef of an existing v3 draft document. This is used
 * after a remote APPEND succeeds so rapid follow-up saves and page reloads
 * never keep using a stale previousRef while React state is still catching up.
 * Returns false when the draft is missing, belongs to a different draftId, or
 * storage throws.
 */
export function updateDraftDocServerRef(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
  serverRef: DraftServerRef | null,
  now: () => number = () => Date.now(),
): boolean {
  try {
    const key = draftKeyV4(accountEmail, draftId);
    const raw = storage.getItem(key);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!isV3Doc(parsed)) return false;
    if (parsed.draftId !== draftId) return false;
    const next: DraftDocV3 = { ...parsed, serverRef, updatedAt: now() };
    storage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** Confirm only the exact local revision/token acknowledged by the provider. */
export function confirmDraftDocRemoteCommit(
  storage: DraftStorageLike,
  accountEmail: string,
  draftId: string,
  input: {
    localRevision: number;
    revisionId: string;
    serverRef: DraftServerRef | null;
    snapshot?: DraftSnapshot;
  },
  now: () => number = () => Date.now(),
): boolean {
  try {
    const key = draftKeyV4(accountEmail, draftId);
    const raw = storage.getItem(key);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!isV3Doc(parsed) || parsed.draftId !== draftId) return false;
    const current = normalizeDraftRecoveryDoc(parsed);
    if (current.localRevision !== input.localRevision || current.revisionId !== input.revisionId) {
      return false;
    }
    const next: DraftDocV3 = {
      ...current,
      snapshot: input.snapshot ?? current.snapshot,
      serverRef: input.serverRef ?? current.serverRef,
      remoteCommittedRevision: input.localRevision,
      remoteCommitConfirmed: true,
      updatedAt: now(),
    };
    storage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure predicate for the reusable clean-close finalization path.
 *
 * Safe to clear the crash-recovery local Draft document ONLY when:
 *   * an explicitly confirmed remote save just happened, OR
 *   * the composer is clean (not dirty) AND its content is already safely
 *     represented remotely (a serverRef exists / saveStatus is "saved").
 *
 * A dirty composer, a failed save, a local-only unsaved draft, or a cancelled
 * close must return false so crash recovery is never lost.
 */
export function shouldFinalizeCleanClose(input: {
  isDirty: boolean;
  serverRef: DraftServerRef | null;
  saveStatus: DraftSaveStatus;
  confirmedSavedServer?: boolean;
}): boolean {
  if (input.confirmedSavedServer === true) return true;
  if (input.isDirty) return false;
  return input.serverRef != null || input.saveStatus === "saved";
}

export function clearDraftDoc(
  storage: DraftStorageLike,
  accountEmail: string,
  expectedDraftId?: string,
): void {
  try {
    if (expectedDraftId) {
      storage.removeItem(draftKeyV4(accountEmail, expectedDraftId));
      if (storage.getItem(activeNewDraftKeyV4(accountEmail)) === expectedDraftId) {
        storage.removeItem(activeNewDraftKeyV4(accountEmail));
      }
    } else {
      const activeDraftId = storage.getItem(activeNewDraftKeyV4(accountEmail));
      if (activeDraftId) storage.removeItem(draftKeyV4(accountEmail, activeDraftId));
      storage.removeItem(activeNewDraftKeyV4(accountEmail));
    }
  } catch {
    /* ignore */
  }
  try {
    const rawLegacy = storage.getItem(draftKeyV3(accountEmail));
    if (!expectedDraftId) {
      storage.removeItem(draftKeyV3(accountEmail));
    } else if (rawLegacy) {
      const parsed: unknown = JSON.parse(rawLegacy);
      if (isV3Doc(parsed) && parsed.draftId === expectedDraftId) {
        storage.removeItem(draftKeyV3(accountEmail));
      }
    }
  } catch {
    /* ignore */
  }
  try {
    // Belt-and-suspenders: sweep the legacy v2 key too.
    if (!expectedDraftId) storage.removeItem(draftKeyV2(accountEmail));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- Saver

export interface DraftSaveCompletion {
  /**
   * Generation number of the SNAPSHOT that was just handed to the remote
   * (whether the remote succeeded or failed). This is the value the caller
   * passed to `requestSave(..., generation)`; when a save is coalesced
   * multiple times, only the most-recently-merged generation is reported —
   * older generations are silently discarded because their content has been
   * superseded before the network round-trip finished.
   *
   * REQUIRED (not optional) so callers relying on the generation-based
   * dirty model can advance `savedGeneration` unconditionally.
   */
  completedGeneration: number;
  /** Stable identity of the logical remote revision that settled. */
  revisionId?: string;
  status: DraftSaveStatus;
  /** Populated only when `status === "saved"` and the bridge returned a UID. */
  serverRef?: DraftServerRef;
  /** The prior identity this successful save replaced, when one was known. */
  previousRef?: DraftServerRef | null;
  /** Bridge proved this revision already existed and performed zero APPENDs. */
  reconciled?: boolean;
  /** Trigger that initiated the physical run (used for automatic timing). */
  trigger?: DraftSaveTriggerDiagnostics;
  /** Coarse error code from the bridge — present when the remote failed. */
  code?: string;
}

export interface CreateDraftSaverOptions {
  saveRemote: (input: {
    draftId: string;
    snapshot: DraftSnapshot;
    previousRef: DraftServerRef | null;
    /** Optional PII-safe trigger diagnostics passed through to the Bridge. */
    trigger?: DraftSaveTriggerDiagnostics;
    /**
     * The revision this exact remote run is persisting. Callers may use it
     * to bind request-scoped bookkeeping (e.g. an attachment signature
     * captured from the transport inputs of THIS run) to the generation
     * that `onCompleted` echoes back.
     */
    generation: number;
    /** Stable across retries of this exact logical generation. */
    revisionId?: string;
  }) => Promise<SaveRemoteResult>;
  onStatus?: (status: DraftSaveStatus) => void;
  onServerRef?: (ref: DraftServerRef) => void;
  /**
   * Fires after each save run settles (success and soft-failure). Stale
   * responses (superseded by a newer request before their round-trip
   * finished) do NOT fire this callback — they are dropped silently, so
   * the caller's `savedGeneration` never advances past the truly-persisted
   * revision and a stale reply cannot mark newer content clean.
   */
  onCompleted?: (info: DraftSaveCompletion) => void;
}

export interface DraftSaver {
  /**
   * Request a save. If another save is in flight this call is coalesced:
   * the newest snapshot + generation are captured and a follow-up run is
   * scheduled to fire exactly once when the in-flight save settles.
   * `generation` is the caller's revision counter (REQUIRED) and is echoed
   * back verbatim via `onCompleted`. The returned promise resolves when
   * THIS caller's snapshot has been offered to the remote (whether success
   * or failure).
   */
  requestSave(
    snapshot: DraftSnapshot,
    previousRef: DraftServerRef | null,
    generation: number,
    trigger?: DraftSaveTriggerDiagnostics,
    revisionId?: string,
  ): Promise<DraftSaveCompletion>;
  isBusy(): boolean;
  getStatus(): DraftSaveStatus;
  /**
   * Resolve once the saver is idle: every in-flight save (running AND any
   * coalesced pending follow-up) has settled. Deterministic drain over the
   * existing single-flight promise — no timers, no busy-polling. Used by
   * explicit Delete Draft so a remote delete never races a still-running
   * APPEND from this composer.
   */
  awaitIdle(): Promise<void>;
  /**
   * Delete-specific drain: discard any queued follow-up save and wait only for
   * the physically running save, if one exists. New queued work must not be
   * started after this is called.
   */
  cancelPendingAndAwaitRunning(): Promise<void>;
}

export function isCleanRemoteDraft(input: {
  isDirty: boolean;
  hasRemoteDraft: boolean;
  serverRef: DraftServerRef | null;
  isEditMode: boolean;
}): boolean {
  return !input.isDirty && (input.hasRemoteDraft || input.serverRef !== null || input.isEditMode);
}

export function shouldCloseAfterUploadWait(input: {
  expectedGeneration: number;
  currentGeneration: number;
  saveSucceeded: boolean;
}): boolean {
  return input.saveSucceeded && input.expectedGeneration === input.currentGeneration;
}

/** A clean already-server-saved Draft may send after an empty no-op save. */
export function shouldSendAfterDraftSave(
  result: "saved_server" | "failed" | "empty",
  alreadyClean: boolean,
): boolean {
  return result === "saved_server" || (result === "empty" && alreadyClean);
}

export function createDraftSaver(draftId: string, opts: CreateDraftSaverOptions): DraftSaver {
  let status: DraftSaveStatus = "idle";
  let seq = 0;
  let latestIssuedSeq = 0;
  let inFlight: Promise<void> | null = null;
  let runningCompletion: Promise<DraftSaveCompletion> | null = null;
  let latestKnownServerRef: DraftServerRef | null = null;
  let runningGeneration: number | null = null;
  let completed: DraftSaveCompletion | null = null;
  // Snapshot queued while a save is in flight ("keep last edit").
  let pending: {
    snapshot: DraftSnapshot;
    previousRef: DraftServerRef | null;
    generation: number;
    trigger?: DraftSaveTriggerDiagnostics;
    revisionId?: string;
    resolvers: Array<(completion: DraftSaveCompletion) => void>;
  } | null = null;

  function setStatus(next: DraftSaveStatus) {
    if (status === next) return;
    status = next;
    opts.onStatus?.(status);
  }

  async function run(
    snapshot: DraftSnapshot,
    previousRef: DraftServerRef | null,
    generation: number,
    trigger?: DraftSaveTriggerDiagnostics,
    revisionId?: string,
  ): Promise<DraftSaveCompletion> {
    const mySeq = ++seq;
    latestIssuedSeq = mySeq;
    setStatus("saving");
    let result: SaveRemoteResult;
    let effectivePreviousRef: DraftServerRef | null = null;
    try {
      effectivePreviousRef = latestKnownServerRef ?? previousRef;
      result = await opts.saveRemote({
        draftId,
        snapshot,
        previousRef: effectivePreviousRef,
        generation,
        trigger,
        revisionId,
      });
    } catch {
      // Thrown remote is a transport failure → NETWORK class.
      result = { ok: false, code: "NETWORK" };
    }
    // Generation guard: only the latest issued sequence may mutate state.
    // Stale responses never fire `onCompleted`, never touch `serverRef`,
    // and therefore never mark newer content clean.
    if (mySeq !== latestIssuedSeq) {
      return {
        completedGeneration: generation,
        revisionId,
        status: "failed",
        code: "SUPERSEDED",
      };
    }
    if (result.ok) {
      if (result.serverRef) {
        latestKnownServerRef = result.serverRef;
        opts.onServerRef?.(result.serverRef);
      }
      setStatus("saved");
      const completion: DraftSaveCompletion = {
        completedGeneration: generation,
        revisionId,
        status: "saved",
        serverRef: result.serverRef,
        previousRef: effectivePreviousRef,
        reconciled: result.reconciled,
        trigger,
      };
      completed = completion;
      opts.onCompleted?.(completion);
      return completion;
    }
    // Failure branch — "saved" may occur ONLY after a successful remote save.
    // Any NETWORK / APPEND / protocol error is a hard failure: the composer
    // stays dirty and the local snapshot is never presented as a saved draft.
    const code = result.code;
    setStatus("failed");
    const completion: DraftSaveCompletion = {
      completedGeneration: generation,
      revisionId,
      status: "failed",
      code,
      trigger,
    };
    completed = completion;
    opts.onCompleted?.(completion);
    return completion;
  }

  let running = false;
  async function loop(): Promise<void> {
    while (pending) {
      const p = pending;
      pending = null;
      running = true;
      runningGeneration = p.generation;
      let completion: DraftSaveCompletion;
      try {
        runningCompletion = run(p.snapshot, p.previousRef, p.generation, p.trigger, p.revisionId);
        completion = await runningCompletion;
      } finally {
        runningCompletion = null;
        running = false;
        runningGeneration = null;
      }
      // Resolve AFTER `running` is cleared so `isBusy()` reads false the
      // instant a waiter observes its own completion.
      for (const r of p.resolvers) r(completion!);
    }
  }

  function requestSave(
    snapshot: DraftSnapshot,
    previousRef: DraftServerRef | null,
    generation: number,
    trigger?: DraftSaveTriggerDiagnostics,
    revisionId?: string,
  ): Promise<DraftSaveCompletion> {
    if (runningGeneration === generation && runningCompletion) return runningCompletion;
    if (completed?.completedGeneration === generation && completed.status === "saved") {
      return Promise.resolve(completed);
    }
    return new Promise<DraftSaveCompletion>((resolve) => {
      if (runningGeneration === generation) {
        if (runningCompletion) void runningCompletion.then(resolve);
        return;
      }
      if (pending) {
        if (pending.generation === generation) {
          pending.resolvers.push(resolve);
          return;
        }
        // Merge: newest snapshot + newest generation win, waiters accumulate.
        pending.snapshot = snapshot;
        pending.previousRef = previousRef;
        pending.generation = generation;
        pending.trigger = trigger;
        pending.revisionId = revisionId;
        pending.resolvers.push(resolve);
      } else {
        pending = { snapshot, previousRef, generation, trigger, revisionId, resolvers: [resolve] };
      }
      if (inFlight) return;
      inFlight = loop().finally(() => {
        inFlight = null;
      });
    });
  }

  // Drain the in-flight pipeline (running save + any coalesced pending). After
  // each await we re-check because a requestSave that lands while we awaited
  // either coalesces into the running loop or starts a fresh one.
  async function awaitIdle(): Promise<void> {
    for (;;) {
      const current = inFlight;
      if (!current) return;
      await current.catch(() => undefined);
    }
  }

  async function cancelPendingAndAwaitRunning(): Promise<void> {
    if (pending) {
      const dropped = pending;
      pending = null;
      const completion: DraftSaveCompletion = {
        completedGeneration: dropped.generation,
        revisionId: dropped.revisionId,
        status: "failed",
        code: "CANCELLED",
      };
      for (const resolve of dropped.resolvers) resolve(completion);
    }
    const current = runningCompletion;
    if (current) await current.catch(() => undefined);
  }

  return {
    requestSave,
    isBusy: () => running || pending !== null,
    getStatus: () => status,
    awaitIdle,
    cancelPendingAndAwaitRunning,
  };
}

// ---------------------------------------------------------------- Pending deletes

export interface PendingDeleteEntry {
  draftId: string;
  previousRef: DraftServerRef | null;
  queuedAt: number;
}

export interface CreatePendingDeleteQueueOptions {
  storage: DraftStorageLike;
  deleteRemote: (input: {
    draftId: string;
    previousRef: DraftServerRef | null;
  }) => Promise<DeleteRemoteResult>;
  now?: () => number;
}

export interface PendingDeleteQueue {
  enqueue(accountEmail: string, entry: Omit<PendingDeleteEntry, "queuedAt">): void;
  list(accountEmail: string): PendingDeleteEntry[];
  /** Try each entry once. Successful entries are removed; failures stay. */
  flush(accountEmail: string): Promise<{ tried: number; deleted: number; kept: number }>;
}

export function deleteDraftAfterSend(input: {
  deleteRemote: () => Promise<boolean>;
  onFailure: () => void;
}): void {
  let failureReported = false;
  const reportFailure = () => {
    if (failureReported) return;
    failureReported = true;
    try {
      input.onFailure();
    } catch {
      /* cleanup diagnostics must never affect the completed send */
    }
  };
  void Promise.resolve()
    .then(input.deleteRemote)
    .then((deleted) => {
      if (!deleted) reportFailure();
    }, reportFailure);
}

function readQueue(storage: DraftStorageLike, accountEmail: string): PendingDeleteEntry[] {
  try {
    const raw = storage.getItem(pendingDeleteKey(accountEmail));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PendingDeleteEntry => !!e && typeof e === "object" && typeof e.draftId === "string",
    );
  } catch {
    return [];
  }
}

function writeQueue(
  storage: DraftStorageLike,
  accountEmail: string,
  entries: PendingDeleteEntry[],
): void {
  try {
    if (entries.length === 0) storage.removeItem(pendingDeleteKey(accountEmail));
    else storage.setItem(pendingDeleteKey(accountEmail), JSON.stringify(entries));
  } catch {
    /* ignore */
  }
}

export function createPendingDeleteQueue(
  opts: CreatePendingDeleteQueueOptions,
): PendingDeleteQueue {
  const now = opts.now ?? (() => Date.now());
  return {
    enqueue(accountEmail, entry) {
      const cur = readQueue(opts.storage, accountEmail);
      // De-dupe by draftId: last write wins.
      const filtered = cur.filter((e) => e.draftId !== entry.draftId);
      filtered.push({ ...entry, queuedAt: now() });
      writeQueue(opts.storage, accountEmail, filtered);
    },
    list(accountEmail) {
      return readQueue(opts.storage, accountEmail);
    },
    async flush(accountEmail) {
      const cur = readQueue(opts.storage, accountEmail);
      if (cur.length === 0) return { tried: 0, deleted: 0, kept: 0 };
      const keep: PendingDeleteEntry[] = [];
      let deleted = 0;
      for (const e of cur) {
        let res: DeleteRemoteResult;
        try {
          res = await opts.deleteRemote({
            draftId: e.draftId,
            previousRef: e.previousRef,
          });
        } catch {
          res = { ok: false, code: "UNKNOWN" };
        }
        if (res.ok) deleted++;
        else keep.push(e);
      }
      writeQueue(opts.storage, accountEmail, keep);
      return { tried: cur.length, deleted, kept: keep.length };
    },
  };
}
