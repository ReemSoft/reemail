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
