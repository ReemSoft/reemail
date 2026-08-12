import { describe, expect, it } from "vitest";
import { MessageOpenIntentGeneration, NavigationGeneration } from "../mail-navigation-race";

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

describe("latest message-open intent", () => {
  it("deduplicates A -> A but creates a fresh operation for A -> B -> A", () => {
    const intents = new MessageOpenIntentGeneration("browser-session");
    const firstA = intents.next("inbox:1");
    const duplicateA = intents.next("inbox:1");
    const b = intents.next("inbox:2");
    const finalA = intents.next("inbox:1");

    expect(duplicateA).toEqual(firstA);
    expect(b.generation).toBe(2);
    expect(finalA).toEqual({ scope: "browser-session", generation: 3 });
  });

  it("rotates the browser-session scope at an account/session boundary", () => {
    let scope = 0;
    const intents = new MessageOpenIntentGeneration(() => `scope-${++scope}`);
    expect(intents.next("inbox:1")).toEqual({ scope: "scope-1", generation: 1 });
    intents.resetScope();
    expect(intents.next("inbox:1")).toEqual({ scope: "scope-2", generation: 1 });
  });
});
