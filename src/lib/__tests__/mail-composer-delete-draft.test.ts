import { describe, expect, it, vi } from "vitest";
import {
  applyDraftDeleteOptimistic,
  deleteSavedDraft,
  rollbackDraftDeleteOptimistic,
  shouldShowDeleteDraft,
} from "../mail-composer-delete-draft";

describe("MAILMAESTRO_COMPOSER_PLACEHOLDERS_AND_DELETE_DRAFT", () => {
  it("shows delete only when a saved local or remote draft exists", () => {
    expect(shouldShowDeleteDraft(false, false)).toBe(false);
    expect(shouldShowDeleteDraft(true, false)).toBe(true);
    expect(shouldShowDeleteDraft(false, true)).toBe(true);
  });

  it("removes both provider and Working Draft projections and decrements exactly once", () => {
    const result = applyDraftDeleteOptimistic(
      {
        messages: [
          { id: "a", draftIdHeader: "draft-1" },
          { id: "b", draftIdHeader: "draft-2" },
          { id: "c" },
        ],
        workingDraftRecords: [{ draftId: "draft-1" }, { draftId: "draft-2" }],
        draftsTotal: 2,
      },
      "draft-1",
    );

    expect(result.messages.map((message) => message.id)).toEqual(["b", "c"]);
    expect(result.workingDraftRecords.map((record) => record.draftId)).toEqual(["draft-2"]);
    expect(result.draftsTotal).toBe(1);
  });

  it("never decrements the Draft count below zero", () => {
    const result = applyDraftDeleteOptimistic(
      { messages: [], workingDraftRecords: [], draftsTotal: 0 },
      "missing",
    );
    expect(result.draftsTotal).toBe(0);
  });

  it("rolls UI/count back to the exact pre-delete snapshot after failure", () => {
    const snapshot = {
      messages: [
        { id: "a", draftIdHeader: "draft-1" },
        { id: "b", draftIdHeader: "draft-2" },
      ],
      workingDraftRecords: [{ draftId: "draft-1" }],
      draftsTotal: 2,
    };
    expect(rollbackDraftDeleteOptimistic(snapshot)).toEqual(snapshot);
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
    ).resolves.toEqual({ ok: true });

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
    ).resolves.toEqual({ ok: true });

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
        deleteRemote: async () => ({ ok: false, code: "IMAP_ERROR" }),
        clearLocal,
        closeWithRefresh,
      }),
    ).resolves.toEqual({ ok: false, code: "IMAP_ERROR" });

    expect(clearLocal).not.toHaveBeenCalled();
    expect(closeWithRefresh).not.toHaveBeenCalled();
  });

  it("propagates the coarse safe DraftErrorCode instead of discarding it", async () => {
    const deleteRemote = vi.fn(async () => ({ ok: false, code: "APPEND_FAILED" }));
    await expect(
      deleteSavedDraft({
        mayHaveRemoteCopy: true,
        deleteRemote,
        clearLocal: vi.fn(),
        closeWithRefresh: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, code: "APPEND_FAILED" });
  });

  it("maps a thrown remote to NETWORK and never exposes provider text", async () => {
    const deleteRemote = vi.fn(async () => {
      throw new Error("ECONNRESET socket closed");
    });
    await expect(
      deleteSavedDraft({
        mayHaveRemoteCopy: true,
        deleteRemote,
        clearLocal: vi.fn(),
        closeWithRefresh: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, code: "NETWORK" });
  });

  it("defaults an undefined failure code to UNKNOWN", async () => {
    await expect(
      deleteSavedDraft({
        mayHaveRemoteCopy: true,
        deleteRemote: async () => ({ ok: false }),
        clearLocal: vi.fn(),
        closeWithRefresh: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, code: "UNKNOWN" });
  });
});
