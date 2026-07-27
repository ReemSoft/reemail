// BLOCKER_6 — account-scoped origin tracker unit tests.
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberOrigin,
  getOrigin,
  forgetOrigin,
  clearAccountOrigins,
  __originKey,
  type OriginStorage,
} from "@/lib/mail-origin-tracker";

function makeStorage(): OriginStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

describe("mail-origin-tracker (BLOCKER_6)", () => {
  let s: ReturnType<typeof makeStorage>;
  beforeEach(() => {
    s = makeStorage();
  });

  it("remember + get round-trip within one account", () => {
    rememberOrigin(s, "acc-A", "thr-1", "archive");
    expect(getOrigin(s, "acc-A", "thr-1")).toBe("archive");
  });

  it("returns 'inbox' as safe default when unknown", () => {
    expect(getOrigin(s, "acc-A", "thr-missing")).toBe("inbox");
    expect(getOrigin(s, null, "thr-1")).toBe("inbox");
    expect(getOrigin(s, "acc-A", undefined)).toBe("inbox");
  });

  it("two accounts do NOT read each other's origins for the same threadId", () => {
    rememberOrigin(s, "acc-A", "thr-shared", "archive");
    rememberOrigin(s, "acc-B", "thr-shared", "spam");
    expect(getOrigin(s, "acc-A", "thr-shared")).toBe("archive");
    expect(getOrigin(s, "acc-B", "thr-shared")).toBe("spam");
  });

  it("forget only removes from the specified account", () => {
    rememberOrigin(s, "acc-A", "thr-1", "archive");
    rememberOrigin(s, "acc-B", "thr-1", "spam");
    forgetOrigin(s, "acc-A", "thr-1");
    expect(getOrigin(s, "acc-A", "thr-1")).toBe("inbox");
    expect(getOrigin(s, "acc-B", "thr-1")).toBe("spam");
  });

  it("clearAccountOrigins wipes only that account's map", () => {
    rememberOrigin(s, "acc-A", "thr-1", "archive");
    rememberOrigin(s, "acc-A", "thr-2", "spam");
    rememberOrigin(s, "acc-B", "thr-1", "archive");
    clearAccountOrigins(s, "acc-A");
    expect(s.store.has(__originKey("acc-A"))).toBe(false);
    expect(getOrigin(s, "acc-A", "thr-1")).toBe("inbox");
    expect(getOrigin(s, "acc-B", "thr-1")).toBe("archive");
  });

  it("rejects writing 'trash' as origin (nonsensical target)", () => {
    rememberOrigin(s, "acc-A", "thr-1", "trash");
    expect(s.store.size).toBe(0);
  });

  it("ignores calls with no accountId (no cross-account bleed)", () => {
    rememberOrigin(s, null, "thr-1", "archive");
    expect(s.store.size).toBe(0);
    forgetOrigin(s, null, "thr-1");
    clearAccountOrigins(s, null);
    expect(s.store.size).toBe(0);
  });

  it("legacy unscoped key from v1 is ignored (never surfaces)", () => {
    // Seed the historical single-key storage used before this module existed.
    s.setItem("mailmaestro:trash-origin", JSON.stringify({ "thr-1": "archive" }));
    expect(getOrigin(s, "acc-A", "thr-1")).toBe("inbox");
  });

  it("repeated remember with the same value does not rewrite (no thrash)", () => {
    rememberOrigin(s, "acc-A", "thr-1", "archive");
    const before = s.store.get(__originKey("acc-A"));
    rememberOrigin(s, "acc-A", "thr-1", "archive");
    const after = s.store.get(__originKey("acc-A"));
    expect(before).toBe(after);
  });

  it("survives corrupted JSON without throwing", () => {
    s.setItem(__originKey("acc-A"), "{not json");
    expect(getOrigin(s, "acc-A", "thr-1")).toBe("inbox");
    // Writing after corruption starts a clean map.
    rememberOrigin(s, "acc-A", "thr-1", "archive");
    expect(getOrigin(s, "acc-A", "thr-1")).toBe("archive");
  });
});
