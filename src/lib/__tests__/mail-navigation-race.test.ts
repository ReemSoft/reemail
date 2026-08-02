import { describe, expect, it } from "vitest";
import { NavigationGeneration } from "../mail-navigation-race";

describe("MAILMAESTRO_INSTANT_NAVIGATION_R1 navigation races", () => {
  it("allows only the last of ten rapid selections to update state", () => {
    const guard = new NavigationGeneration();
    const generations = Array.from({ length: 10 }, () => guard.next());
    expect(generations.filter((generation) => guard.isCurrent(generation))).toEqual([10]);
  });

  it("invalidates pending responses on a scope change", () => {
    const guard = new NavigationGeneration();
    const pending = guard.next();
    guard.invalidate();
    expect(guard.isCurrent(pending)).toBe(false);
  });
});
