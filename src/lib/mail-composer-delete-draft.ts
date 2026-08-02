/**
 * MAILMAESTRO_COMPOSER_PLACEHOLDERS_AND_DELETE_DRAFT
 *
 * Coordinates the existing remote and local draft lifecycle operations. The
 * remote copy is always removed first, so a failed IMAP delete cannot erase
 * the recoverable local copy or close the composer.
 */
export interface DeleteSavedDraftOptions {
  mayHaveRemoteCopy: boolean;
  deleteRemote: () => Promise<{ ok: boolean }>;
  clearLocal: () => void;
  closeWithRefresh: () => void;
}

export function shouldShowDeleteDraft(hasLocalCopy: boolean, hasRemoteCopy: boolean): boolean {
  return hasLocalCopy || hasRemoteCopy;
}

export async function deleteSavedDraft({
  mayHaveRemoteCopy,
  deleteRemote,
  clearLocal,
  closeWithRefresh,
}: DeleteSavedDraftOptions): Promise<boolean> {
  if (mayHaveRemoteCopy) {
    try {
      const result = await deleteRemote();
      if (!result.ok) return false;
    } catch {
      return false;
    }
  }

  clearLocal();
  closeWithRefresh();
  return true;
}
