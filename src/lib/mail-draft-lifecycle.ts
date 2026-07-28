/**
 * Draft lifecycle module — MAILMAESTRO_DRAFT_APPEND_R1 (M4-B).
 *
 * Client-side orchestration around the M3 bridge server functions
 * (`bridgeSaveDraft` / `bridgeDeleteDraft`). This module is UI-agnostic and
 * fully unit-testable: it never touches React, `window`, or the network
 * directly. Callers inject a `Storage` (localStorage-shaped), a remote
 * `saveRemote` / `deleteRemote` pair, and observe state via callbacks.
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
 *   * Server ref is updated ONLY on ok=true. On error the local snapshot
 *     is still persisted (status → "saved-local"). Only true persistence
 *     failure (storage quota, etc.) transitions to "failed".
 *   * Pending-cleanup queue: when a post-send delete fails, the entry is
 *     persisted per-account and retried on the next composer open / next
 *     save flush. Successful entries are removed atomically.
 */

// ---------------------------------------------------------------- Types

export type DraftSaveStatus = "idle" | "saving" | "saved" | "saved-local" | "failed";

/**
 * Bridge error codes that MUST be treated as recoverable "local-only" saves.
 * Only true network / transport failures qualify — any protocol-level or
 * permission-level error is a HARD failure and leaves the composer dirty so
 * the user can retry (or lose nothing on close).
 *
 * Locked by tests: adding a code here relaxes the failure contract, so the
 * list is intentionally narrow and reviewed.
 */
export const NETWORK_SOFT_FAIL_CODES: ReadonlySet<string> = new Set(["NETWORK"]);

export interface DraftRecipient {
  email: string;
  name?: string;
  valid: boolean;
}

export interface DraftSnapshot {
  to: DraftRecipient[];
  cc: DraftRecipient[];
  bcc: DraftRecipient[];
  subject: string;
  html: string;
  showCc: boolean;
  showBcc: boolean;
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
export const DRAFT_PENDING_DELETE_PREFIX = "mailmaestro:draft-pending-delete:v1:";

export function draftKeyV3(accountEmail: string): string {
  return `${DRAFT_V3_KEY_PREFIX}${accountEmail}`;
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
  const v3Key = draftKeyV3(accountEmail);
  try {
    const rawV3 = storage.getItem(v3Key);
    if (rawV3) {
      const parsed: unknown = JSON.parse(rawV3);
      if (isV3Doc(parsed)) return parsed;
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
    };
    storage.setItem(v3Key, JSON.stringify(doc));
    // Only remove v2 AFTER v3 write succeeded (no data loss on a quota error).
    storage.removeItem(v2Key);
    return doc;
  } catch {
    return null;
  }
}

/** Write a v3 doc. Returns true when persisted, false on quota / IO. */
export function writeDraftDoc(
  storage: DraftStorageLike,
  accountEmail: string,
  doc: DraftDocV3,
): boolean {
  try {
    storage.setItem(draftKeyV3(accountEmail), JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

export function clearDraftDoc(storage: DraftStorageLike, accountEmail: string): void {
  try {
    storage.removeItem(draftKeyV3(accountEmail));
  } catch {
    /* ignore */
  }
  try {
    // Belt-and-suspenders: sweep the legacy v2 key too.
    storage.removeItem(draftKeyV2(accountEmail));
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
  status: DraftSaveStatus;
  /** Populated only when `status === "saved"` and the bridge returned a UID. */
  serverRef?: DraftServerRef;
  /** Coarse error code from the bridge — present when the remote failed. */
  code?: string;
}

export interface CreateDraftSaverOptions {
  saveRemote: (input: {
    draftId: string;
    snapshot: DraftSnapshot;
    previousRef: DraftServerRef | null;
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
  ): Promise<void>;
  isBusy(): boolean;
  getStatus(): DraftSaveStatus;
}

export function createDraftSaver(draftId: string, opts: CreateDraftSaverOptions): DraftSaver {
  let status: DraftSaveStatus = "idle";
  let seq = 0;
  let latestIssuedSeq = 0;
  let inFlight: Promise<void> | null = null;
  // Snapshot queued while a save is in flight ("keep last edit").
  let pending: {
    snapshot: DraftSnapshot;
    previousRef: DraftServerRef | null;
    generation: number;
    resolvers: Array<() => void>;
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
  ): Promise<void> {
    const mySeq = ++seq;
    latestIssuedSeq = mySeq;
    setStatus("saving");
    let result: SaveRemoteResult;
    try {
      result = await opts.saveRemote({ draftId, snapshot, previousRef });
    } catch {
      // Thrown remote is a transport failure → NETWORK class.
      result = { ok: false, code: "NETWORK" };
    }
    // Generation guard: only the latest issued sequence may mutate state.
    // Stale responses never fire `onCompleted`, never touch `serverRef`,
    // and therefore never mark newer content clean.
    if (mySeq !== latestIssuedSeq) return;
    if (result.ok) {
      if (result.serverRef) opts.onServerRef?.(result.serverRef);
      setStatus("saved");
      opts.onCompleted?.({
        completedGeneration: generation,
        status: "saved",
        serverRef: result.serverRef,
      });
      return;
    }
    // Failure branch — classify by code.
    const code = result.code;
    const isSoftNetwork = code != null && NETWORK_SOFT_FAIL_CODES.has(code);
    if (isSoftNetwork) {
      // Local persistence is the caller's responsibility (writeDraftDoc)
      // and happens synchronously before requestSave. A NETWORK failure
      // therefore leaves the composer in "saved-local" — the local write
      // succeeded, only the transport dropped.
      setStatus("saved-local");
      opts.onCompleted?.({
        completedGeneration: generation,
        status: "saved-local",
        code,
      });
      return;
    }
    // Hard failure: protocol / auth / quota / unknown. Do NOT pretend the
    // draft was saved anywhere the user can rely on — leave composer dirty.
    setStatus("failed");
    opts.onCompleted?.({
      completedGeneration: generation,
      status: "failed",
      code,
    });
  }

  let running = false;
  async function loop(): Promise<void> {
    while (pending) {
      const p = pending;
      pending = null;
      running = true;
      try {
        await run(p.snapshot, p.previousRef, p.generation);
      } finally {
        running = false;
      }
      // Resolve AFTER `running` is cleared so `isBusy()` reads false the
      // instant a waiter observes its own completion.
      for (const r of p.resolvers) r();
    }
  }

  function requestSave(
    snapshot: DraftSnapshot,
    previousRef: DraftServerRef | null,
    generation: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (pending) {
        // Merge: newest snapshot + newest generation win, waiters accumulate.
        pending.snapshot = snapshot;
        pending.previousRef = previousRef;
        pending.generation = generation;
        pending.resolvers.push(resolve);
      } else {
        pending = { snapshot, previousRef, generation, resolvers: [resolve] };
      }
      if (inFlight) return;
      inFlight = loop().finally(() => {
        inFlight = null;
      });
    });
  }

  return {
    requestSave,
    isBusy: () => running || pending !== null,
    getStatus: () => status,
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
