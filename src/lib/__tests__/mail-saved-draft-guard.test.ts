// Just-saved Draft readability guard — deterministic unit tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSavedDraftGuard,
  type SavedDraftIdentity,
} from "../mail-saved-draft-guard";

function identity(overrides: Partial<SavedDraftIdentity> = {}): SavedDraftIdentity {
  return {
    accountId: "acc-1",
    draftId: "draft-1",
    folderPath: "[Gmail]/Drafts",
    uidValidity: "42",
    uid: 100,
    ...overrides,
  };
}

describe("createSavedDraftGuard.record / find", () => {
  it("records a confirmed identity and matches it exactly", () => {
    const g = createSavedDraftGuard();
    const id = identity();
    g.record(id);
    expect(g.find("acc-1", "42", 100)).toEqual(id);
  });

  it("does not record an invalid identity (failed/local-only save)", () => {
    const g = createSavedDraftGuard();
    g.record(identity({ uid: 0 }));
    g.record(identity({ uidValidity: "" }));
    g.record(identity({ folderPath: "" }));
    g.record(identity({ draftId: "" }));
    expect(g.find("acc-1", "42", 100)).toBeNull();
    expect(g.find("acc-1", "", 0)).toBeNull();
  });

  it("re-save with a new UID replaces the old identity (no stale UID)", () => {
    const g = createSavedDraftGuard();
    g.record(identity({ uid: 100 }));
    g.record(identity({ uid: 101 }));
    expect(g.find("acc-1", "42", 101)).toEqual(identity({ uid: 101 }));
    expect(g.find("acc-1", "42", 100)).toBeNull();
  });

  it("does not match a different account / uidValidity / uid", () => {
    const g = createSavedDraftGuard();
    g.record(identity());
    expect(g.find("acc-2", "42", 100)).toBeNull();
    expect(g.find("acc-1", "43", 100)).toBeNull();
    expect(g.find("acc-1", "42", 200)).toBeNull();
  });

  it("a newer UID means the old UID is no longer protected", () => {
    const g = createSavedDraftGuard();
    g.record(identity({ uid: 100 }));
    const old = g.find("acc-1", "42", 100);
    expect(old).not.toBeNull();
    g.record(identity({ uid: 101 }));
    expect(g.find("acc-1", "42", 100)).toBeNull();
    expect(g.find("acc-1", "42", 101)).not.toBeNull();
  });
});

describe("createSavedDraftGuard.clear*", () => {
  it("clearDraft removes only the matching draftId", () => {
    const g = createSavedDraftGuard();
    g.record(identity({ draftId: "draft-1", uid: 100 }));
    g.record(identity({ draftId: "draft-2", uid: 200 }));
    g.clearDraft("acc-1", "draft-1");
    expect(g.find("acc-1", "42", 100)).toBeNull();
    expect(g.find("acc-1", "42", 200)).not.toBeNull();
  });

  it("clearAccount removes only that account's identities", () => {
    const g = createSavedDraftGuard();
    g.record(identity({ accountId: "acc-1" }));
    g.record(identity({ accountId: "acc-2", uid: 300 }));
    g.clearAccount("acc-1");
    expect(g.find("acc-1", "42", 100)).toBeNull();
    expect(g.find("acc-2", "42", 300)).not.toBeNull();
  });

  it("clearAll removes identities and recovery attempts", () => {
    const g = createSavedDraftGuard();
    const id = identity();
    g.record(id);
    g.markRecoveryAttempted(id);
    g.clearAll();
    expect(g.find("acc-1", "42", 100)).toBeNull();
    expect(g.hasRecoveryAttempted(id)).toBe(false);
  });
});

describe("createSavedDraftGuard stale Draft aliases", () => {
  it("records X -> Y and resolves old X to current Y", () => {
    const g = createSavedDraftGuard();
    const x = identity({ uid: 100 });
    const y = identity({ uid: 101 });
    g.recordReplacement(x, y);
    expect(g.findStale("acc-1", "42", 100)).toEqual(y);
    expect(g.findStale("acc-1", "42", 101)).toBeNull();
  });

  it("resolves X -> Y -> Z directly to Z without a chain", () => {
    const g = createSavedDraftGuard();
    const x = identity({ uid: 100 });
    const y = identity({ uid: 101 });
    const z = identity({ uid: 102 });
    g.recordReplacement(x, y);
    g.recordReplacement(y, z);
    expect(g.findStale("acc-1", "42", 100)).toEqual(z);
    expect(g.findStale("acc-1", "42", 101)).toEqual(z);
    expect(g.findStale("acc-1", "42", 102)).toBeNull();
  });

  it("normal current identity has no redirect", () => {
    const g = createSavedDraftGuard();
    g.record(identity({ uid: 100 }));
    expect(g.findStale("acc-1", "42", 100)).toBeNull();
  });

  it("different account or uidValidity never resolves a stale alias", () => {
    const g = createSavedDraftGuard();
    g.recordReplacement(identity({ uid: 100 }), identity({ uid: 101 }));
    expect(g.findStale("acc-2", "42", 100)).toBeNull();
    expect(g.findStale("acc-1", "43", 100)).toBeNull();
  });

  it("clearDraft removes stale aliases for that draft only", () => {
    const g = createSavedDraftGuard();
    g.recordReplacement(identity({ draftId: "draft-1", uid: 100 }), identity({ draftId: "draft-1", uid: 101 }));
    g.recordReplacement(identity({ draftId: "draft-2", uid: 200 }), identity({ draftId: "draft-2", uid: 201 }));
    g.clearDraft("acc-1", "draft-1");
    expect(g.findStale("acc-1", "42", 100)).toBeNull();
    expect(g.findStale("acc-1", "42", 200)).toEqual(identity({ draftId: "draft-2", uid: 201 }));
  });

  it("clearAccount and clearAll remove aliases", () => {
    const g = createSavedDraftGuard();
    g.recordReplacement(identity({ accountId: "acc-1", uid: 100 }), identity({ accountId: "acc-1", uid: 101 }));
    g.recordReplacement(identity({ accountId: "acc-2", uid: 200 }), identity({ accountId: "acc-2", uid: 201 }));
    g.clearAccount("acc-1");
    expect(g.findStale("acc-1", "42", 100)).toBeNull();
    expect(g.findStale("acc-2", "42", 200)).not.toBeNull();
    g.clearAll();
    expect(g.findStale("acc-2", "42", 200)).toBeNull();
  });

  it("keeps a stale alias while its exact operation is in flight", () => {
    const g = createSavedDraftGuard();
    g.recordReplacement(identity({ uid: 100 }), identity({ uid: 101 }));
    g.markInFlight("acc-1", "42", 100);
    g.pruneAfterAuthoritativeRefresh("acc-1", "42", new Set([101]));
    expect(g.findStale("acc-1", "42", 100)).toEqual(identity({ uid: 101 }));
  });

  it("prunes a settled stale alias after an authoritative refresh", () => {
    const g = createSavedDraftGuard();
    g.recordReplacement(identity({ uid: 100 }), identity({ uid: 101 }));
    g.markInFlight("acc-1", "42", 100);
    g.pruneAfterAuthoritativeRefresh("acc-1", "42", new Set([101]));
    g.releaseInFlight("acc-1", "42", 100);
    expect(g.findStale("acc-1", "42", 100)).toBeNull();
  });

  it("prunes immediately when no operation is in flight", () => {
    const g = createSavedDraftGuard();
    g.recordReplacement(identity({ uid: 100 }), identity({ uid: 101 }));
    g.pruneAfterAuthoritativeRefresh("acc-1", "42", new Set([101]));
    expect(g.findStale("acc-1", "42", 100)).toBeNull();
  });

  it("repeated saves do not grow after authoritative refresh and settled requests", () => {
    const g = createSavedDraftGuard();
    for (let uid = 100; uid < 120; uid += 1) {
      g.recordReplacement(identity({ uid }), identity({ uid: uid + 1 }));
      g.markInFlight("acc-1", "42", uid);
      g.pruneAfterAuthoritativeRefresh("acc-1", "42", new Set([uid + 1]));
      g.releaseInFlight("acc-1", "42", uid);
    }
    expect(g.findStale("acc-1", "42", 119)).toBeNull();
    expect(g.findStale("acc-1", "42", 100)).toBeNull();
  });
});

describe("createSavedDraftGuard recovery attempts", () => {
  it("tracks at most one recovery attempt per exact identity", () => {
    const g = createSavedDraftGuard();
    const id = identity();
    expect(g.hasRecoveryAttempted(id)).toBe(false);
    g.markRecoveryAttempted(id);
    expect(g.hasRecoveryAttempted(id)).toBe(true);
  });

  it("a new UID (re-save) is a distinct recovery identity", () => {
    const g = createSavedDraftGuard();
    const first = identity({ uid: 100 });
    const second = identity({ uid: 101 });
    g.markRecoveryAttempted(first);
    expect(g.hasRecoveryAttempted(second)).toBe(false);
  });
});

describe("no timers / TTL / persistence", () => {
  it("does not reference timers, localStorage, or timestamps", () => {
    // The guard module is pure in-memory. Lock that no timer/persistence
    // mechanism sneaks in (precise call/access patterns, ignoring the doc text).
    const src = readFileSync(new URL("../mail-saved-draft-guard.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/setTimeout\s*\(|setInterval\s*\(/);
    expect(src).not.toMatch(/localStorage\s*\.|sessionStorage\s*\.|globalThis\s*\.|window\s*\./);
    expect(src).not.toMatch(/Date\s*\.now|new\s+Date/);
  });
});
