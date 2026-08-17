/**
 * MAILMAESTRO_COMPOSER_PLACEHOLDERS_AND_DELETE_DRAFT
 *
 * Coordinates the existing remote and local draft lifecycle operations. The
 * remote copy is always removed first, so a failed IMAP delete cannot erase
 * the recoverable local copy or close the composer.
 */
export interface DeleteSavedDraftOptions {
  mayHaveRemoteCopy: boolean;
  /**
   * Returns `{ ok: true }` on success, or `{ ok: false, code }` where `code`
   * is a coarse, PII-safe DraftErrorCode (never provider text, subject,
   * recipient, draftId or UID).
   */
  deleteRemote: () => Promise<{ ok: boolean; code?: string }>;
  clearLocal: () => void;
  closeWithRefresh: () => void;
}

export type DeleteSavedDraftResult = { ok: true } | { ok: false; code: string };

export function shouldShowDeleteDraft(hasLocalCopy: boolean, hasRemoteCopy: boolean): boolean {
  return hasLocalCopy || hasRemoteCopy;
}

export interface DraftListSnapshot<
  TMessage extends { draftIdHeader?: string },
  TRecord extends { draftId: string },
> {
  messages: TMessage[];
  workingDraftRecords: TRecord[];
  draftsTotal: number;
}

/**
 * Pure optimistic projection for an explicit Draft delete. It removes every
 * provider/Working Draft row carrying the deleted draftId and decrements the
 * Draft count exactly once, never below zero.
 */
export function applyDraftDeleteOptimistic<
  TMessage extends { draftIdHeader?: string },
  TRecord extends { draftId: string },
>(
  snapshot: DraftListSnapshot<TMessage, TRecord>,
  draftId: string,
): { messages: TMessage[]; workingDraftRecords: TRecord[]; draftsTotal: number } {
  return {
    messages: snapshot.messages.filter((message) => message.draftIdHeader !== draftId),
    workingDraftRecords: snapshot.workingDraftRecords.filter((record) => record.draftId !== draftId),
    draftsTotal: Math.max(0, snapshot.draftsTotal - 1),
  };
}

/** Restores the exact pre-delete snapshot when the explicit delete fails. */
export function rollbackDraftDeleteOptimistic<
  TMessage extends { draftIdHeader?: string },
  TRecord extends { draftId: string },
>(
  snapshot: DraftListSnapshot<TMessage, TRecord>,
): DraftListSnapshot<TMessage, TRecord> {
  return snapshot;
}

export async function deleteSavedDraft({
  mayHaveRemoteCopy,
  deleteRemote,
  clearLocal,
  closeWithRefresh,
}: DeleteSavedDraftOptions): Promise<DeleteSavedDraftResult> {
  if (mayHaveRemoteCopy) {
    let result: { ok: boolean; code?: string };
    try {
      result = await deleteRemote();
    } catch {
      result = { ok: false, code: "NETWORK" };
    }
    if (!result.ok) return { ok: false, code: result.code ?? "UNKNOWN" };
  }

  clearLocal();
  closeWithRefresh();
  return { ok: true };
}
