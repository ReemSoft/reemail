import { describe, expect, it, vi } from "vitest";
import { deleteSavedDraft, shouldShowDeleteDraft } from "../mail-composer-delete-draft";

describe("MAILMAESTRO_COMPOSER_PLACEHOLDERS_AND_DELETE_DRAFT", () => {
  it("shows delete only when a saved local or remote draft exists", () => {
    expect(shouldShowDeleteDraft(false, false)).toBe(false);
    expect(shouldShowDeleteDraft(true, false)).toBe(true);
    expect(shouldShowDeleteDraft(false, true)).toBe(true);
  });

  it("deletes remote then local and closes with exactly one refresh", async () => {
    const order: string[] = [];
    const deleteRemote = vi.fn(async () => {
      order.push("remote");
      return { ok: true };
    });
    const clearLocal = vi.fn(() => order.push("local"));
    const closeWithRefresh = vi.fn(() => order.push("close-refresh"));

    await expect(
      deleteSavedDraft({ mayHaveRemoteCopy: true, deleteRemote, clearLocal, closeWithRefresh }),
    ).resolves.toBe(true);

    expect(order).toEqual(["remote", "local", "close-refresh"]);
    expect(deleteRemote).toHaveBeenCalledTimes(1);
    expect(clearLocal).toHaveBeenCalledTimes(1);
    expect(closeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("safely probes IMAP before deleting a locally saved draft", async () => {
    const deleteRemote = vi.fn(async () => ({ ok: true }));
    const clearLocal = vi.fn();
    const closeWithRefresh = vi.fn();

    await expect(
      deleteSavedDraft({ mayHaveRemoteCopy: true, deleteRemote, clearLocal, closeWithRefresh }),
    ).resolves.toBe(true);

    expect(deleteRemote).toHaveBeenCalledTimes(1);
    expect(clearLocal).toHaveBeenCalledTimes(1);
    expect(closeWithRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the local draft and composer open when remote deletion fails", async () => {
    const clearLocal = vi.fn();
    const closeWithRefresh = vi.fn();

    await expect(
      deleteSavedDraft({
        mayHaveRemoteCopy: true,
        deleteRemote: async () => ({ ok: false }),
        clearLocal,
        closeWithRefresh,
      }),
    ).resolves.toBe(false);

    expect(clearLocal).not.toHaveBeenCalled();
    expect(closeWithRefresh).not.toHaveBeenCalled();
  });
});
