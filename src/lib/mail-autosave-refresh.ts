/**
 * MAILMAESTRO_AUTOSAVE_NO_FULL_COUNTS
 *
 * Tracks the small piece of state needed to keep autosave away from mailbox
 * refreshes. A successful remote save may optimistically create one Drafts
 * row, while the authoritative refresh is consumed once when the composer
 * closes. Failed/local-only saves never affect the server-backed count.
 */
export interface DraftAutosaveRefreshTracker {
  noteRemoteSave(): { incrementDraftCount: boolean };
  consumeCloseRefresh(): boolean;
}

export function createDraftAutosaveRefreshTracker(
  remoteCopyExists: boolean,
): DraftAutosaveRefreshTracker {
  let hasRemoteCopy = remoteCopyExists;
  let savedChangePendingRefresh = false;

  return {
    noteRemoteSave() {
      const incrementDraftCount = !hasRemoteCopy;
      hasRemoteCopy = true;
      savedChangePendingRefresh = true;
      return { incrementDraftCount };
    },
    consumeCloseRefresh() {
      if (!savedChangePendingRefresh) return false;
      savedChangePendingRefresh = false;
      return true;
    },
  };
}

export function shouldRefreshDraftsOnFolderEntry(previous: string, next: string): boolean {
  return previous !== "drafts" && next === "drafts";
}
