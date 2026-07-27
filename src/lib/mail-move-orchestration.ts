// Pure, dependency-injected orchestration core for `indexMoveMessage`
// (Blocker 2: BLOCKER_2_TARGETED_SYNC).
//
// Contract: IMAP is the source of truth. After a successful IMAP move we
//   * ALWAYS confirm the source (either via a 1-UID reconcile when a source
//     cursor exists, or via `tombstone-only`) — a failure here NEVER rolls
//     the UI back to the source folder.
//   * SHORT-CIRCUIT destination sync only when the Bridge returned UIDPLUS
//     mapping AND the write-through already inserted the row locally with a
//     matching UIDVALIDITY. Anything else runs a TARGETED destination sync
//     (never a full-account sync, never `/api/move` more than once).
//   * DISCOVER the real destination UID from the Local Index using the
//     fingerprint we captured BEFORE the move — never invent a UID from
//     the source UID, never pick a random candidate.
//
// The module has zero server-only imports so it can be unit-tested with a
// fake `MoveOrchestrationDeps`. `mail-move.functions.ts` wires the real
// server-only implementations behind `deps` inside its handler.
import type { DiscoveredDestination, MessageFingerprint } from "@/lib/mail-move-writer.server";

export interface BridgeMoveInfo {
  sourceUid: number;
  destinationPath?: string;
  destinationUid?: number;
  destinationUidValidity?: string;
  uidMappingAvailable: boolean;
}

export type BridgeMoveOutcome =
  | { ok: true; move: BridgeMoveInfo }
  | { ok: false; error: string; code: string };

export type WriteThroughOutcome =
  | {
      ok: true;
      applied: "full" | "source-only" | "no-source-folder";
      sourceTombstoned: boolean;
      destinationInserted: boolean;
    }
  | { ok: false; error: string };

export type SyncOutcome =
  | { ok: true; busy: false; hasMore: boolean }
  | { ok: true; busy: true }
  | { ok: false; error: string; code: string };

/**
 * Result of a 1-UID reconcile against the physical source folder.
 * `targetUidPresent` MUST be derived from the Bridge's IMAP response
 * (never from Local Index, which is Tombstoned before this call).
 */
export type SourceReconcileOutcome =
  | { ok: true; busy: false; targetUidPresent: boolean }
  | { ok: true; busy: true }
  | { ok: false; error: string; code: string };


export interface SourceInfo {
  /** Physical source: `starred` collapses to INBOX. */
  folderId: string;
  uidvalidity: number;
  path: string;
  canonical: string;
  /** `null` when the folder has never been synced. */
  cursorNewestSyncedUid: number | null;
  /** May be `null` when the source row isn't indexed (still safe to move). */
  fingerprint: MessageFingerprint | null;
}

export interface DestInfo {
  folder: {
    id: string;
    uidvalidity: number | null;
    path: string | null;
  } | null;
  /** Cutoff for destination discovery. `null` when there's no prior cursor. */
  cursorNewestSyncedUid: number | null;
}

export interface MoveOrchestrationDeps {
  /** Load pre-move source info (physical folder, cursor, fingerprint). */
  loadSource: () => Promise<SourceInfo | null>;
  /** Load pre-move destination info (folder row + cursor). */
  loadDest: () => Promise<DestInfo>;
  /** Call Bridge `/api/move` — MUST run exactly once. */
  bridgeMove: () => Promise<BridgeMoveOutcome>;
  /** Apply the existing write-through against the local index. */
  applyWriteThrough: (move: BridgeMoveInfo) => Promise<WriteThroughOutcome>;
  /** Targeted destination sync: `initial` when no cursor, `incremental` otherwise. */
  runDestSync: (params: {
    folderPath: string;
    canonical: string;
    mode: "initial" | "incremental";
  }) => Promise<SyncOutcome>;
  /** Reload destination info AFTER a sync round so we can discover UIDs. */
  reloadDest: () => Promise<DestInfo>;
  /** Discover the moved message's UID using the pre-captured fingerprint. */
  discoverDest: (params: {
    folderId: string;
    uidvalidity: number;
    cutoffUid: number;
    fingerprint: MessageFingerprint;
  }) => Promise<DiscoveredDestination | null>;
  /** Source confirmation: single-UID reconcile on the physical source. */
  runSourceReconcile: (params: {
    folderPath: string;
    canonical: string;
    uid: number;
  }) => Promise<SourceReconcileOutcome>;
  /** Safe server-side logger (no secrets). */
  logError?: (label: string, err: unknown) => void;
}

export interface MoveOrchestrationInput {
  sourceCanonical: string;
  destCanonical: string;
  sourceUid: number;
}

export type SourceConfirmation =
  | "confirmed-absent"
  | "still-present"
  | "tombstone-only"
  | "busy"
  | "failed";
export type DestinationSync = "not-needed" | "incremental" | "initial" | "busy" | "failed";

export type IndexApplied = "full" | "source-only" | "no-source-folder" | "partial";

export type MoveOrchestrationResult =
  | {
      ok: true;
      imap: true;
      move: BridgeMoveInfo;
      index: IndexApplied;
      sourceConfirmation: SourceConfirmation;
      destinationSync: DestinationSync;
      destinationReady: boolean;
      discoveredDestinationUid?: number;
      discoveredDestinationUidValidity?: string;
    }
  | { ok: false; error: string; code: string };

/** Hard ceiling on targeted incremental rounds — never infinite. */
export const MAX_TARGETED_ROUNDS = 3;

export async function moveMessageOrchestration(
  deps: MoveOrchestrationDeps,
  input: MoveOrchestrationInput,
): Promise<MoveOrchestrationResult> {
  const logErr = deps.logError ?? (() => {});

  // ---- 1) Capture pre-move source + destination state ----
  let source: SourceInfo | null = null;
  let destBefore: DestInfo = { folder: null, cursorNewestSyncedUid: null };
  try {
    source = await deps.loadSource();
  } catch (e) {
    logErr("[move] loadSource failed", e);
  }
  try {
    destBefore = await deps.loadDest();
  } catch (e) {
    logErr("[move] loadDest failed", e);
  }

  // ---- 2) Bridge move (single call) ----
  const bridge = await deps.bridgeMove();
  if (!bridge.ok) {
    return { ok: false, error: bridge.error, code: bridge.code };
  }
  const move = bridge.move;

  // ---- 3) Write-through against local index ----
  let indexApplied: IndexApplied = "partial";
  let destinationInserted = false;
  let writeThroughFailed = false;
  try {
    const wt = await deps.applyWriteThrough(move);
    if (wt.ok) {
      indexApplied = wt.applied;
      destinationInserted = wt.destinationInserted;
    } else {
      writeThroughFailed = true;
      logErr("[move] applyWriteThrough failed", wt.error);
    }
  } catch (e) {
    writeThroughFailed = true;
    logErr("[move] applyWriteThrough threw", e);
  }

  // ---- 4) Full-mapping short-circuit: NO targeted sync at all ----
  const fullMapping =
    move.uidMappingAvailable &&
    indexApplied === "full" &&
    destinationInserted &&
    typeof move.destinationUid === "number" &&
    typeof move.destinationUidValidity === "string";

  let destinationSync: DestinationSync = "not-needed";
  let destinationReady = false;
  let discoveredUid: number | undefined;
  let discoveredUv: string | undefined;

  if (fullMapping) {
    destinationReady = true;
    discoveredUid = move.destinationUid;
    discoveredUv = move.destinationUidValidity;
  } else {
    // ---- 5) Targeted destination sync + discovery ----
    // Contract (BLOCKER_2_FIX):
    //   * destPath existence alone is enough to RUN the targeted sync.
    //   * A missing fingerprint means we cannot uniquely IDENTIFY the moved
    //     UID afterwards — but the sync must still hydrate the destination
    //     folder so the row appears when the user opens it. Never fabricate
    //     a UID; never call discoverDest without a fingerprint.
    const destPath = move.destinationPath ?? destBefore.folder?.path ?? null;
    const cutoff = destBefore.cursorNewestSyncedUid ?? 0;

    if (!destPath) {
      destinationSync = "failed";
    } else {
      const mode: "initial" | "incremental" =
        destBefore.folder && destBefore.cursorNewestSyncedUid != null ? "incremental" : "initial";
      destinationSync = mode;

      let rounds = 0;
      let currentDest = destBefore;
      while (rounds < MAX_TARGETED_ROUNDS) {
        rounds += 1;
        const syncRes = await deps.runDestSync({
          folderPath: destPath,
          canonical: input.destCanonical,
          mode,
        });
        if (syncRes.ok && syncRes.busy) {
          destinationSync = "busy";
          break;
        }
        if (!syncRes.ok) {
          destinationSync = "failed";
          break;
        }

        // Reload destination folder so we can discover the moved UID.
        try {
          currentDest = await deps.reloadDest();
        } catch (e) {
          logErr("[move] reloadDest failed", e);
        }

        // Discovery is impossible without a fingerprint (row was not in the
        // Local Index at capture time). Skip discovery entirely; the sync
        // still hydrated the destination folder, so the message will
        // surface when the user opens it. destinationReady stays false —
        // the UI overlay will clear on the next background poll.
        if (source?.fingerprint && currentDest.folder && currentDest.folder.uidvalidity != null) {
          try {
            const hit = await deps.discoverDest({
              folderId: currentDest.folder.id,
              uidvalidity: currentDest.folder.uidvalidity,
              cutoffUid: cutoff,
              fingerprint: source.fingerprint,
            });
            if (hit) {
              destinationReady = true;
              discoveredUid = hit.uid;
              discoveredUv = String(hit.uidvalidity);
              break;
            }
          } catch (e) {
            logErr("[move] discoverDest failed", e);
          }
        }

        // Only INCREMENTAL follows hasMore. INITIAL runs exactly once.
        if (mode !== "incremental" || !syncRes.hasMore) break;
      }
    }
  }

  // ---- 6) Source confirmation (never rolls back on failure) ----
  // Presence MUST come from IMAP (Bridge), not Local Index — the source row
  // is Tombstoned before this call, so the index would always say "absent".
  let sourceConfirmation: SourceConfirmation = "tombstone-only";
  if (source && source.cursorNewestSyncedUid != null) {
    try {
      const res = await deps.runSourceReconcile({
        folderPath: source.path,
        canonical: source.canonical,
        uid: input.sourceUid,
      });
      if (res.ok && !res.busy) {
        sourceConfirmation = res.targetUidPresent ? "still-present" : "confirmed-absent";
      } else if (res.ok && res.busy) {
        sourceConfirmation = "busy";
      } else {
        sourceConfirmation = "failed";
      }
    } catch (e) {
      logErr("[move] runSourceReconcile failed", e);
      sourceConfirmation = "failed";
    }
  }

  // ---- 7) Compute final `index` — never claim "full" when destination or
  // source confirmation is degraded. IMAP success is never rolled back.
  const hasFailure =
    writeThroughFailed ||
    destinationSync === "failed" ||
    destinationSync === "busy" ||
    sourceConfirmation === "failed" ||
    sourceConfirmation === "busy" ||
    sourceConfirmation === "still-present";
  const finalIndex: IndexApplied = hasFailure ? "partial" : indexApplied;

  const out: MoveOrchestrationResult = {
    ok: true,
    imap: true,
    move,
    index: finalIndex,
    sourceConfirmation,
    destinationSync,
    destinationReady,
  };
  if (destinationReady && discoveredUid != null) {
    out.discoveredDestinationUid = discoveredUid;
    if (discoveredUv != null) out.discoveredDestinationUidValidity = discoveredUv;
  }
  return out;
}

