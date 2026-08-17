/**
 * Draft-only count-hydration guard.
 *
 * Keeps the optimistic Draft total after a Draft-origin Send even when a later
 * count request reads a stale Local Index response. Non-Draft callers pass
 * `preserveDraftTotal: false` and keep the previous behavior unchanged.
 */

export interface FolderCountHydrationValue {
  total: number;
  unread: number;
  supported: boolean;
}

export interface DraftCountGuardState {
  active: boolean;
  total: number;
  pendingSentDraftIds: Set<string>;
  cleanupConfirmed: boolean;
}

export function createDraftCountGuard(): DraftCountGuardState {
  return {
    active: false,
    total: 0,
    pendingSentDraftIds: new Set<string>(),
    cleanupConfirmed: false,
  };
}

export function activateDraftCountGuard(
  guard: DraftCountGuardState,
  total: number,
  draftId: string,
): void {
  guard.active = true;
  guard.total = Math.max(0, total);
  guard.pendingSentDraftIds.add(draftId);
  guard.cleanupConfirmed = false;
}

export function syncDraftCountGuardTotal(
  guard: DraftCountGuardState,
  total: number,
): void {
  if (!guard.active) return;
  guard.total = Math.max(0, total);
}

export function clearDraftCountGuard(guard: DraftCountGuardState): void {
  guard.active = false;
  guard.pendingSentDraftIds.clear();
  guard.cleanupConfirmed = false;
}

export function reconcileDraftCountGuardCleanup(
  guard: DraftCountGuardState,
  records: readonly { draftId: string }[],
  sentDraftRefs: readonly { draftId: string }[],
): void {
  if (!guard.active) return;
  const recordIds = new Set(records.map((record) => record.draftId));
  const sentRefIds = new Set(sentDraftRefs.map((ref) => ref.draftId));
  for (const draftId of [...guard.pendingSentDraftIds]) {
    if (!recordIds.has(draftId) && !sentRefIds.has(draftId)) {
      guard.pendingSentDraftIds.delete(draftId);
    }
  }
  guard.cleanupConfirmed = guard.pendingSentDraftIds.size === 0;
}

export function hydrateFolderCount(input: {
  folder: string;
  previous?: FolderCountHydrationValue;
  incoming: FolderCountHydrationValue;
  preserveDraftTotal?: boolean;
  guardedDraftTotal?: number;
}): FolderCountHydrationValue {
  if (input.folder === "drafts" && input.guardedDraftTotal !== undefined) {
    return {
      total: Math.max(0, input.guardedDraftTotal),
      unread: input.incoming.unread,
      supported: input.incoming.supported,
    };
  }
  if (input.preserveDraftTotal && input.folder === "drafts" && input.previous) {
    return {
      total: input.previous.total,
      unread: input.incoming.unread,
      supported: input.incoming.supported,
    };
  }
  return input.incoming;
}
