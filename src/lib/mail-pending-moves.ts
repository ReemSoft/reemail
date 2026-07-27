// Pending Move Overlay (BLOCKER_3_PENDING_MOVE_OVERLAY).
//
// Purpose (internal-only; NO visible UI indicator):
//   Prevent any stale row coming from Local Mail Index, Bridge, pagination,
//   background sync, deep search, or message prefetch/cache from resurrecting
//   a message that the user just moved / trashed / archived / restored /
//   permanently-deleted from its source folder.
//
// Contract highlights:
//   * Identity is (accountId + physicalSourceFolder + sourceUid), with
//     "starred" collapsed to "inbox" (starred is a virtual \Flagged view of
//     INBOX, so `starred:42` and `inbox:42` are the same physical row).
//   * Entry lifecycle: pending → confirmed. NEVER cleared by a timer.
//     Cleared ONLY by a subsequent source-folder read that (a) started AFTER
//     `confirmedAt` and (b) came back without the source UID.
//   * `applyPendingMoveOverlay` filters ANY server-fetched list. The
//     destination folder row is NOT suppressed — matching is per physical
//     source folder, so an unrelated Destination UID that happens to equal
//     the Source UID stays visible.
//   * Cross-account isolation: an Account A entry never suppresses an
//     Account B row.
//   * Dependency-free (no React, no server-only imports) so it can be unit-
//     tested and reused from every list surface.
import type { MailMessage } from "@/lib/mail-types";

export type PendingMoveOperation =
  | "move"
  | "trash"
  | "archive"
  | "restore"
  | "permanent-delete";

export type PendingMoveSourceConfirmation =
  | "confirmed-absent"
  | "still-present"
  | "tombstone-only"
  | "busy"
  | "failed";

export interface PendingMoveEntry {
  accountId: string;
  /** Physical folder — `starred` is collapsed to `inbox`. */
  physicalSourceFolder: string;
  sourceUid: number;
  sourceUidValidity?: number;
  messageId?: string | null;

  status: "pending" | "confirmed";
  startedAt: number;
  confirmedAt?: number;
  sourceConfirmation?: PendingMoveSourceConfirmation;

  operation: PendingMoveOperation;
}

/** Map<compositeKey, PendingMoveEntry>. */
export type PendingMovesMap = Map<string, PendingMoveEntry>;

/** Normalize a folder name to the physical IMAP mailbox identity. */
export function normalizePhysicalFolder(folder: string | null | undefined): string {
  if (!folder) return "";
  return folder === "starred" ? "inbox" : folder;
}

/** Composite key for a single physical row. */
export function pendingMoveKey(
  accountId: string,
  physicalSourceFolder: string,
  sourceUid: number,
): string {
  return `${accountId}\u0000${normalizePhysicalFolder(physicalSourceFolder)}\u0000${sourceUid}`;
}

/** Parse a MailMessage id (`folder:uid`) into its physical identity parts. */
export function parsePhysicalIdentity(
  messageId: string,
): { physicalFolder: string; uid: number } | null {
  const colon = messageId.indexOf(":");
  if (colon <= 0) return null;
  const folder = messageId.slice(0, colon);
  const uidStr = messageId.slice(colon + 1);
  if (!uidStr || !/^\d+$/.test(uidStr)) return null;
  const uid = Number(uidStr);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  return { physicalFolder: normalizePhysicalFolder(folder), uid };
}

// ==================================================================
// Lifecycle
// ==================================================================

export interface BeginPendingMoveInput {
  accountId: string;
  /** Raw source folder ("starred"/"inbox"/…); will be normalized. */
  sourceFolder: string;
  sourceUid: number;
  sourceUidValidity?: number;
  messageId?: string | null;
  operation: PendingMoveOperation;
  now?: number;
}

/** Enter a `pending` entry. Idempotent per identity: replaces any prior entry. */
export function beginPendingMove(
  entries: PendingMovesMap,
  input: BeginPendingMoveInput,
): PendingMoveEntry {
  const physicalSourceFolder = normalizePhysicalFolder(input.sourceFolder);
  const entry: PendingMoveEntry = {
    accountId: input.accountId,
    physicalSourceFolder,
    sourceUid: input.sourceUid,
    sourceUidValidity: input.sourceUidValidity,
    messageId: input.messageId ?? null,
    status: "pending",
    startedAt: input.now ?? Date.now(),
    operation: input.operation,
  };
  entries.set(pendingMoveKey(input.accountId, physicalSourceFolder, input.sourceUid), entry);
  return entry;
}

export interface ConfirmPendingMoveInput {
  accountId: string;
  sourceFolder: string;
  sourceUid: number;
  sourceConfirmation?: PendingMoveSourceConfirmation;
  now?: number;
}

/** IMAP-success confirmation. The entry stays until a source-read reconciles it. */
export function confirmPendingMove(
  entries: PendingMovesMap,
  input: ConfirmPendingMoveInput,
): PendingMoveEntry | null {
  const key = pendingMoveKey(input.accountId, input.sourceFolder, input.sourceUid);
  const cur = entries.get(key);
  if (!cur) return null;
  const next: PendingMoveEntry = {
    ...cur,
    status: "confirmed",
    confirmedAt: input.now ?? Date.now(),
    sourceConfirmation: input.sourceConfirmation ?? cur.sourceConfirmation,
  };
  entries.set(key, next);
  return next;
}

/** IMAP-failure rollback: drop the entry so the row can re-appear. */
export function rollbackPendingMove(
  entries: PendingMovesMap,
  input: { accountId: string; sourceFolder: string; sourceUid: number },
): boolean {
  return entries.delete(
    pendingMoveKey(input.accountId, input.sourceFolder, input.sourceUid),
  );
}

/** Drop every entry belonging to `accountId` (used on logout / account switch). */
export function clearPendingMovesForAccount(
  entries: PendingMovesMap,
  accountId: string,
): number {
  let removed = 0;
  for (const [k, e] of entries) {
    if (e.accountId === accountId) {
      entries.delete(k);
      removed++;
    }
  }
  return removed;
}

// ==================================================================
// Overlay
// ==================================================================

/**
 * Return true if `messageId` (folder:uid) is currently suppressed by any
 * pending-move entry for `accountId`. Destination-folder rows are NOT
 * suppressed because they resolve to a different physical folder than the
 * entry's source folder — matching is keyed on the source folder only.
 */
export function isMessageSuppressed(
  entries: PendingMovesMap,
  accountId: string,
  messageId: string,
): boolean {
  if (entries.size === 0) return false;
  const parsed = parsePhysicalIdentity(messageId);
  if (!parsed) return false;
  return entries.has(pendingMoveKey(accountId, parsed.physicalFolder, parsed.uid));
}

/** Apply the overlay to a list of messages (pure — returns a new array). */
export function applyPendingMoveOverlay(
  list: MailMessage[],
  entries: PendingMovesMap,
  accountId: string | null | undefined,
): MailMessage[] {
  if (!accountId || entries.size === 0) return list;
  return list.filter((m) => !isMessageSuppressed(entries, accountId, m.id));
}

// ==================================================================
// Reconcile-after-source-read
// ==================================================================

export interface ReconcileAfterSourceReadInput {
  accountId: string;
  /** Physical folder that was just read (starred is collapsed to inbox). */
  physicalSourceFolder: string;
  /** Timestamp captured BEFORE the list request was issued. */
  requestStartedAt: number;
  /**
   * The RAW (unfiltered) result list from the same read. Used to check
   * whether the source UID actually disappeared from IMAP.
   */
  rawList: ReadonlyArray<Pick<MailMessage, "id">>;
}

/**
 * GC pass with strict rules (BLOCKER_3):
 *   * Only touches entries whose (accountId + physicalSourceFolder) matches
 *     the request scope. A Trash/Archive load never GC's an Inbox entry.
 *   * Only drops `confirmed` entries whose `confirmedAt` is strictly older
 *     than `requestStartedAt` (the list started AFTER confirmation).
 *   * Only drops entries whose source UID is NOT present in the raw list.
 *     If the source UID is still there (e.g. `still-present` from IMAP,
 *     racing pre-mutation response, etc.) the entry stays.
 * Returns the number of entries removed (for tests).
 */
export function reconcilePendingMovesAfterSourceRead(
  entries: PendingMovesMap,
  input: ReconcileAfterSourceReadInput,
): number {
  if (entries.size === 0) return 0;
  const scopeFolder = normalizePhysicalFolder(input.physicalSourceFolder);
  const scopeAccount = input.accountId;
  // Build a set of "physical uids present in raw list" for O(1) checks.
  const presentUids = new Set<number>();
  for (const m of input.rawList) {
    const p = parsePhysicalIdentity(m.id);
    if (!p) continue;
    if (p.physicalFolder !== scopeFolder) continue;
    presentUids.add(p.uid);
  }
  let removed = 0;
  for (const [k, e] of entries) {
    if (e.accountId !== scopeAccount) continue;
    if (e.physicalSourceFolder !== scopeFolder) continue;
    if (e.status !== "confirmed") continue;
    if (e.confirmedAt == null) continue;
    if (!(input.requestStartedAt > e.confirmedAt)) continue;
    if (presentUids.has(e.sourceUid)) continue;
    entries.delete(k);
    removed++;
  }
  return removed;
}

// ==================================================================
// Session-storage persistence (opt-in helpers; no secrets ever stored).
// ==================================================================

const STORAGE_KEY = "mailmaestro.pending-moves.v1";

export function serializePendingMoves(entries: PendingMovesMap): string {
  return JSON.stringify(Array.from(entries.values()));
}

export function deserializePendingMoves(raw: string | null): PendingMovesMap {
  const map: PendingMovesMap = new Map();
  if (!raw) return map;
  try {
    const arr = JSON.parse(raw) as PendingMoveEntry[];
    if (!Array.isArray(arr)) return map;
    for (const e of arr) {
      if (
        !e ||
        typeof e.accountId !== "string" ||
        typeof e.physicalSourceFolder !== "string" ||
        typeof e.sourceUid !== "number"
      )
        continue;
      map.set(
        pendingMoveKey(e.accountId, e.physicalSourceFolder, e.sourceUid),
        {
          ...e,
          physicalSourceFolder: normalizePhysicalFolder(e.physicalSourceFolder),
        },
      );
    }
  } catch {
    /* corrupt storage – ignore */
  }
  return map;
}

export function loadPendingMovesFromSession(): PendingMovesMap {
  if (typeof sessionStorage === "undefined") return new Map();
  return deserializePendingMoves(sessionStorage.getItem(STORAGE_KEY));
}

export function savePendingMovesToSession(entries: PendingMovesMap): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, serializePendingMoves(entries));
  } catch {
    /* quota — best effort */
  }
}
