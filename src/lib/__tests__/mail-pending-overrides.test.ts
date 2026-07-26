// Regression tests for the Pending Flag Overrides helper. Guards the
// contract used by the mail list UI: server-provided rows must never
// clobber a still-pending optimistic star/read; overrides are GC'd only
// when the server confirms the expected value.
import { describe, it, expect } from "vitest";
import {
  applyHidden,
  applyOverrides,
  applyOverrideToOne,
  clearOverride,
  clearOverrideField,
  confirmHide,
  gcHiddenBefore,
  hideId,
  reconcileOverrides,
  setOverride,
  unhideId,
  type HiddenIdsSet,
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

  it("applyHidden is a no-op when the set is empty", () => {
    const list = [msg("inbox:1"), msg("inbox:2")];
    const out = applyHidden(list, new Map());
    expect(out).toBe(list);
  });

  it("applyHidden filters out ids that were optimistically removed", () => {
    const list = [msg("inbox:1"), msg("inbox:2"), msg("inbox:3")];
    const hidden: HiddenIdsSet = new Map();
    hideId(hidden, "inbox:2");
    const out = applyHidden(list, hidden);
    expect(out.map((m) => m.id)).toEqual(["inbox:1", "inbox:3"]);
  });

  it("unhideId restores a previously hidden id", () => {
    const list = [msg("inbox:1"), msg("inbox:2")];
    const hidden: HiddenIdsSet = new Map();
    hideId(hidden, "inbox:1");
    unhideId(hidden, "inbox:1");
    expect(applyHidden(list, hidden).map((m) => m.id)).toEqual(["inbox:1", "inbox:2"]);
  });

  it("hidden filter keeps a row suppressed even when a racing sync returns it", () => {
    // User unstarred inbox:1 in the starred folder — we remove it and hide
    // its id; a background sync response still contains the row because the
    // server hasn't cleared the flag yet. It must NOT re-appear.
    const hidden: HiddenIdsSet = new Map();
    hideId(hidden, "inbox:1");
    const stale = [msg("inbox:1", true, false), msg("inbox:2", true, false)];
    const out = applyHidden(stale, hidden);
    expect(out.map((m) => m.id)).toEqual(["inbox:2"]);
  });

  it("gcHiddenBefore keeps PENDING hides regardless of the cutoff", () => {
    // A hide whose mutation is still in flight must never be auto-dropped
    // by a list load — the server truth hasn't caught up yet.
    const hidden: HiddenIdsSet = new Map();
    hideId(hidden, "starred:1");
    const removed = gcHiddenBefore(hidden, Date.now() + 1_000_000);
    expect(removed).toBe(0);
    expect(hidden.has("starred:1")).toBe(true);
  });

  it("gcHiddenBefore drops a CONFIRMED hide whose confirmedAt <= cutoff", () => {
    // Mutation succeeded at t=100. A subsequent list load started at t=200
    // is guaranteed to reflect the flip → the hide is safe to release.
    const hidden: HiddenIdsSet = new Map();
    hideId(hidden, "starred:1");
    confirmHide(hidden, "starred:1", 100);
    const removed = gcHiddenBefore(hidden, 200);
    expect(removed).toBe(1);
    expect(hidden.has("starred:1")).toBe(false);
  });

  it("gcHiddenBefore keeps a CONFIRMED hide whose confirmedAt > cutoff", () => {
    // The list was requested BEFORE the mutation confirmed → response
    // predates the flip and may still contain the row. Keep the hide.
    const hidden: HiddenIdsSet = new Map();
    confirmHide(hidden, "starred:1", 300);
    const removed = gcHiddenBefore(hidden, 200);
    expect(removed).toBe(0);
    expect(hidden.has("starred:1")).toBe(true);
  });

  it("cross-folder re-star: unhiding 'starred:<uid>' releases a stale hide", () => {
    // Simulates the flow: user unstarred inbox:5 while inside Starred
    // (hide entry keyed as "starred:5"); later re-stars the same message
    // from Inbox (mutation id = "inbox:5"). toggleStar's re-star branch
    // explicitly unhides "starred:5" so it reappears in Starred.
    const hidden: HiddenIdsSet = new Map();
    hideId(hidden, "starred:5");
    // Simulate the re-star path clearing both namespaces.
    unhideId(hidden, "inbox:5");
    unhideId(hidden, "starred:5");
    const list = [msg("starred:5", true, false)];
    expect(applyHidden(list, hidden).map((m) => m.id)).toEqual(["starred:5"]);
  });
});

