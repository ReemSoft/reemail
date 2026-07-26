// Regression tests for the Pending Flag Overrides helper. Guards the
// contract used by the mail list UI: server-provided rows must never
// clobber a still-pending optimistic star/read; overrides are GC'd only
// when the server confirms the expected value.
import { describe, it, expect } from "vitest";
import {
  applyOverrides,
  applyOverrideToOne,
  clearOverride,
  clearOverrideField,
  reconcileOverrides,
  setOverride,
  type OverridesMap,
} from "../mail-pending-overrides";
import type { MailMessage } from "@/lib/mail-types";

function msg(id: string, starred = false, read = false): MailMessage {
  return {
    id,
    threadId: id,
    folder: "inbox",
    from: { name: "", email: "a@b.co" },
    to: [],
    subject: "s",
    preview: "",
    body: "",
    date: new Date(0).toISOString(),
    read,
    starred,
    hasAttachments: false,
  };
}

describe("mail-pending-overrides", () => {
  it("applyOverrides is a no-op when the map is empty", () => {
    const list = [msg("inbox:1"), msg("inbox:2")];
    const out = applyOverrides(list, new Map());
    expect(out).toBe(list);
  });

  it("patches starred/read for matching ids only", () => {
    const list = [msg("inbox:1", false, false), msg("inbox:2", true, true)];
    const ov: OverridesMap = new Map();
    setOverride(ov, "inbox:1", { starred: true });
    setOverride(ov, "inbox:2", { read: false });
    const out = applyOverrides(list, ov);
    expect(out[0]!.starred).toBe(true);
    expect(out[0]!.read).toBe(false);
    expect(out[1]!.starred).toBe(true);
    expect(out[1]!.read).toBe(false);
  });

  it("applyOverrideToOne returns the same reference when no override exists", () => {
    const m = msg("inbox:1");
    expect(applyOverrideToOne(m, new Map())).toBe(m);
  });

  it("setOverride merges into existing entry without dropping the other field", () => {
    const ov: OverridesMap = new Map();
    setOverride(ov, "inbox:1", { starred: true });
    setOverride(ov, "inbox:1", { read: true });
    expect(ov.get("inbox:1")).toEqual({ starred: true, read: true });
  });

  it("clearOverrideField drops only the named field; deletes entry when empty", () => {
    const ov: OverridesMap = new Map();
    setOverride(ov, "inbox:1", { starred: true, read: true });
    clearOverrideField(ov, "inbox:1", "starred");
    expect(ov.get("inbox:1")).toEqual({ read: true });
    clearOverrideField(ov, "inbox:1", "read");
    expect(ov.has("inbox:1")).toBe(false);
  });

  it("clearOverride removes the whole entry", () => {
    const ov: OverridesMap = new Map();
    setOverride(ov, "inbox:1", { starred: true, read: true });
    clearOverride(ov, "inbox:1");
    expect(ov.has("inbox:1")).toBe(false);
  });

  it("reconcileOverrides drops fields only when the server row already matches", () => {
    const ov: OverridesMap = new Map();
    setOverride(ov, "inbox:1", { starred: true });
    setOverride(ov, "inbox:2", { starred: true, read: false });
    // Server says inbox:1 is now starred (matches) → drop.
    // Server says inbox:2 is still not starred (drift) → keep starred, drop read match.
    const list = [msg("inbox:1", true, false), msg("inbox:2", false, false)];
    reconcileOverrides(list, ov);
    expect(ov.has("inbox:1")).toBe(false);
    expect(ov.get("inbox:2")).toEqual({ starred: true });
  });

  it("keeps pending override when a stale server row disagrees (star race)", () => {
    // User just starred inbox:1; a slow background load returns the OLD value.
    const ov: OverridesMap = new Map();
    setOverride(ov, "inbox:1", { starred: true });
    const stale = [msg("inbox:1", false, false)];
    reconcileOverrides(stale, ov);
    expect(ov.get("inbox:1")).toEqual({ starred: true });
    // And the applied list shows the intended value, not the stale one.
    expect(applyOverrides(stale, ov)[0]!.starred).toBe(true);
  });
});
