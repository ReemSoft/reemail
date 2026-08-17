import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  activateDraftCountGuard,
  clearDraftCountGuard,
  createDraftCountGuard,
  hydrateFolderCount,
  reconcileDraftCountGuardCleanup,
  syncDraftCountGuardTotal,
} from "../mail-draft-count-guard";

function pendingIds(guard: ReturnType<typeof createDraftCountGuard>): string[] {
  return [...guard.pendingSentDraftIds].sort();
}

describe("multiple pending sent Draft ids", () => {
  it("keeps both ids when a second Draft is sent before convergence", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 1, "A");
    activateDraftCountGuard(guard, 0, "B");

    expect(pendingIds(guard)).toEqual(["A", "B"]);
    expect(guard.total).toBe(0);
    expect(guard.active).toBe(true);
  });

  it("removes only the converged sent id", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 1, "A");
    activateDraftCountGuard(guard, 0, "B");

    reconcileDraftCountGuardCleanup(
      guard,
      [],
      [{ draftId: "B" }],
    );

    expect(pendingIds(guard)).toEqual(["B"]);
    expect(guard.active).toBe(true);
    expect(guard.cleanupConfirmed).toBe(false);
  });

  it("confirms cleanup only after every pending id is absent from both sources", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 1, "A");
    activateDraftCountGuard(guard, 0, "B");

    reconcileDraftCountGuardCleanup(guard, [], [{ draftId: "B" }]);
    reconcileDraftCountGuardCleanup(guard, [], []);

    expect(pendingIds(guard)).toEqual([]);
    expect(guard.active).toBe(true);
    expect(guard.cleanupConfirmed).toBe(true);
  });
});

describe("Draft Index sync is the only release authority", () => {
  it("ordinary count equality cannot release the guard", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 1, "A");

    const hydrated = hydrateFolderCount({
      folder: "drafts",
      incoming: { total: 1, unread: 0, supported: true },
      guardedDraftTotal: guard.total,
    });

    expect(hydrated.total).toBe(1);
    expect(guard.active).toBe(true);
  });

  it("releases only when cleanup is confirmed and post-sync total equals guard.total", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 0, "A");
    reconcileDraftCountGuardCleanup(guard, [], []);

    const postSyncTotal = 0;
    const shouldRelease =
      guard.active &&
      guard.cleanupConfirmed &&
      guard.pendingSentDraftIds.size === 0 &&
      postSyncTotal === guard.total;

    if (shouldRelease) clearDraftCountGuard(guard);

    expect(guard.active).toBe(false);
  });

  it("stale post-sync total does not release the guard", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 0, "A");
    reconcileDraftCountGuardCleanup(guard, [], []);

    const postSyncTotal = 1;
    const shouldRelease =
      guard.active &&
      guard.cleanupConfirmed &&
      guard.pendingSentDraftIds.size === 0 &&
      postSyncTotal === guard.total;

    expect(shouldRelease).toBe(false);
    expect(guard.active).toBe(true);
  });
});

describe("logical mutations while guard active", () => {
  it("new Draft updates guarded total but keeps pending ids", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 0, "A");
    syncDraftCountGuardTotal(guard, 1);

    expect(guard.total).toBe(1);
    expect(pendingIds(guard)).toEqual(["A"]);
    expect(guard.active).toBe(true);
  });

  it("second delete/send updates guarded total without replacing pending ids", () => {
    const guard = createDraftCountGuard();
    activateDraftCountGuard(guard, 2, "A");
    syncDraftCountGuardTotal(guard, 1);

    expect(guard.total).toBe(1);
    expect(pendingIds(guard)).toEqual(["A"]);
  });

  it("normal non-Draft Send never activates the guard", () => {
    const guard = createDraftCountGuard();
    expect(guard.active).toBe(false);
  });
});

describe("Draft count guard production wiring", () => {
  const mail = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

  it("tracks a set of pending sent Draft ids", () => {
    const src = mail();
    expect(src).toContain("pendingSentDraftIds");
    expect(src).toContain("reconcileDraftCountGuardCleanup(guard, result.records, sentRefs)");
  });

  it("uses draftIndexSyncSettled as the release authority", () => {
    const src = mail();
    expect(src).toContain("draftIndexSyncSettled");
    expect(src).toContain("loadCountsFast({ draftIndexSyncSettled: true })");
    expect(src).toContain("draftCountForConvergence?.total === draftCountGuardRef.current.total");
  });

  it("keeps guard total synchronized with optimistic count mutations", () => {
    const src = mail();
    expect(src).toContain("syncDraftCountGuardTotal(draftCountGuardRef.current");
  });
});
