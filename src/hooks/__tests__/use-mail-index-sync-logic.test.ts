// Regression tests for the coalescing/notification decision used by the
// mail-index background sync loop. Guards against future changes that
// re-introduce spurious UI refreshes on every 45s poll.
import { describe, it, expect } from "vitest";
import { hasMeaningfulChange } from "../use-mail-index-sync";

const base = {
  ok: true as const,
  mode: "incremental" as const,
  wroteMessages: 0,
  appliedFlagChanges: 0,
  tombstoned: 0,
  wipedForUidValidity: false,
};

describe("hasMeaningfulChange", () => {
  it("returns false for a no-op incremental tick", () => {
    expect(hasMeaningfulChange({ ...base } as never)).toBe(false);
  });
  it("always returns true for mode=initial (first paint)", () => {
    expect(hasMeaningfulChange({ ...base, mode: "initial" } as never)).toBe(true);
  });
  it("returns true when messages were written", () => {
    expect(hasMeaningfulChange({ ...base, wroteMessages: 1 } as never)).toBe(true);
  });
  it("returns true when tombstones were applied (moves/deletes)", () => {
    expect(hasMeaningfulChange({ ...base, mode: "reconcile", tombstoned: 4 } as never)).toBe(true);
  });
  it("returns true when flag changes were applied (star/read drift)", () => {
    expect(
      hasMeaningfulChange({ ...base, mode: "reconcile", appliedFlagChanges: 2 } as never),
    ).toBe(true);
  });
  it("returns true when uidvalidity wiped (folder recreated on server)", () => {
    expect(hasMeaningfulChange({ ...base, wipedForUidValidity: true } as never)).toBe(true);
  });
});
