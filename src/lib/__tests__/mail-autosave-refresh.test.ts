import { describe, expect, it, vi } from "vitest";
import {
  createDraftAutosaveRefreshTracker,
  shouldRefreshDraftsOnFolderEntry,
} from "../mail-autosave-refresh";

describe("MAILMAESTRO_AUTOSAVE_NO_FULL_COUNTS", () => {
  it("several autosaves never call full counts or reload Drafts", () => {
    const tracker = createDraftAutosaveRefreshTracker(false);
    const fullCounts = vi.fn();
    const reloadDrafts = vi.fn();
    let optimisticIncrements = 0;

    for (let i = 0; i < 4; i++) {
      const result = tracker.noteRemoteSave();
      if (result.incrementDraftCount) optimisticIncrements++;
    }

    expect(optimisticIncrements).toBe(1);
    expect(fullCounts).not.toHaveBeenCalled();
    expect(reloadDrafts).not.toHaveBeenCalled();
  });

  it("closing after saved changes requests exactly one authoritative refresh", () => {
    const tracker = createDraftAutosaveRefreshTracker(false);
    const refresh = vi.fn();
    tracker.noteRemoteSave();
    tracker.noteRemoteSave();
    tracker.noteRemoteSave();

    if (tracker.consumeCloseRefresh()) refresh();
    if (tracker.consumeCloseRefresh()) refresh();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("opening Drafts requests fresh state only on folder entry", () => {
    expect(shouldRefreshDraftsOnFolderEntry("inbox", "drafts")).toBe(true);
    expect(shouldRefreshDraftsOnFolderEntry("sent", "drafts")).toBe(true);
    expect(shouldRefreshDraftsOnFolderEntry("drafts", "drafts")).toBe(false);
    expect(shouldRefreshDraftsOnFolderEntry("drafts", "inbox")).toBe(false);
  });

  it("editing an existing server draft never increments the count", () => {
    const tracker = createDraftAutosaveRefreshTracker(true);
    expect(tracker.noteRemoteSave().incrementDraftCount).toBe(false);
    expect(tracker.noteRemoteSave().incrementDraftCount).toBe(false);
  });

  it("a failed autosave leaves count and close refresh untouched", () => {
    const tracker = createDraftAutosaveRefreshTracker(false);
    const optimisticCount = vi.fn();
    const refresh = vi.fn();

    // Failure deliberately does not call noteRemoteSave().
    if (tracker.consumeCloseRefresh()) refresh();

    expect(optimisticCount).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
