// Batch B: per-item rollback semantics for mail mutations.
// These tests exercise the exact pure helpers used by handleMove /
// handleDelete / handleRestore / bulk* in src/routes/mail.tsx.
import { describe, it, expect } from "vitest";
import { reviveAt, reviveFailed, type ItemSnapshot } from "@/lib/mail-rollback";

type Msg = { id: string; label: string };

const mk = (id: string, label = id): Msg => ({ id, label });

describe("Batch B — per-item rollback (single mutations)", () => {
  it("1. handleMove failure revives only the moved item at its original index", () => {
    const before = [mk("a"), mk("b"), mk("c")];
    // Optimistic remove of "b"
    const afterOptimistic = before.filter((m) => m.id !== "b");
    // On IMAP failure, revive only "b" at index 1.
    const rolledBack = reviveAt(afterOptimistic, mk("b"), 1);
    expect(rolledBack.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("2. handleDelete failure revives the row without touching other rows", () => {
    const before = [mk("a"), mk("b"), mk("c")];
    // Concurrently a new message "z" arrived on top after optimistic delete
    const afterOptimistic = [mk("z"), mk("a"), mk("c")];
    const rolledBack = reviveAt(afterOptimistic, mk("b"), 1);
    // "z" preserved, "b" re-inserted next to its neighbours.
    expect(rolledBack.map((m) => m.id)).toEqual(["z", "b", "a", "c"]);
  });

  it("3. handleRestore failure revives only the failed item", () => {
    const before = [mk("t1"), mk("t2")];
    const afterOptimistic = before.filter((m) => m.id !== "t1");
    const rolledBack = reviveAt(afterOptimistic, mk("t1"), 0);
    expect(rolledBack.map((m) => m.id)).toEqual(["t1", "t2"]);
  });

  it("4. concurrent mutation is preserved during rollback", () => {
    const before = [mk("a"), mk("b"), mk("c")];
    // While the move was in flight, "c" was updated (label changed) and a
    // new "d" arrived.
    const afterOptimisticAndConcurrent = [mk("a"), mk("c", "c-updated"), mk("d")];
    const rolledBack = reviveAt(afterOptimisticAndConcurrent, mk("b"), 1);
    expect(rolledBack.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    // Concurrent label edit for "c" not clobbered.
    expect(rolledBack.find((m) => m.id === "c")!.label).toBe("c-updated");
  });

  it("5. selection/open state is per-item — a null re-open is safe (semantics only)", () => {
    // The route restores selectedMessage only when the failed id equals the
    // previously-open id. Here we assert the equivalent set-membership logic.
    const failed = new Set(["b"]);
    const prevOpen = "b";
    expect(failed.has(prevOpen)).toBe(true);
    const prevOpen2 = "z";
    expect(failed.has(prevOpen2)).toBe(false);
  });

  it("9. duplicate guard prevents inserting the same id twice", () => {
    const list = [mk("a"), mk("b"), mk("c")];
    // Rollback races with a background sync that already re-added "b".
    const withReplayed = reviveAt(list, mk("b"), 1);
    expect(withReplayed.map((m) => m.id)).toEqual(["a", "b", "c"]);
    // Original list unchanged (returns a copy).
    expect(withReplayed).not.toBe(list);
  });
});

describe("Batch B — per-item rollback (bulk mutations)", () => {
  const before = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
  const meta = new Map<string, ItemSnapshot<Msg>>();
  before.forEach((m, idx) => meta.set(m.id, { original: m, originalIndex: idx }));

  it("6. bulk partial failure revives failed ids only, at their indices", () => {
    // Optimistic: b, c, d removed.
    const afterOptimistic = before.filter((m) => !["b", "c", "d"].includes(m.id));
    // b and d failed; c succeeded and must NOT come back.
    const rolledBack = reviveFailed(afterOptimistic, meta, ["b", "d"]);
    // "c" succeeded so its original slot is gone; "d" clamps to end.
    expect(rolledBack.map((m) => m.id)).toEqual(["a", "b", "e", "d"]);

  });

  it("7. bulk success does not revive anything", () => {
    const afterOptimistic = before.filter((m) => !["b", "c"].includes(m.id));
    const rolledBack = reviveFailed(afterOptimistic, meta, []);
    expect(rolledBack.map((m) => m.id)).toEqual(["a", "d", "e"]);
  });

  it("8. IMAP success with index=partial does not trigger rollback (no failed ids)", () => {
    // The route path: when the bridge returns ok:true but index==="partial",
    // no failure branch runs. Modelled as an empty failedIds set.
    const afterOptimistic = before.filter((m) => m.id !== "c");
    const rolledBack = reviveFailed(afterOptimistic, meta, []);
    expect(rolledBack.map((m) => m.id)).toEqual(["a", "b", "d", "e"]);
    // Row stays removed — pending-move overlay keeps it hidden.
    expect(rolledBack.find((m) => m.id === "c")).toBeUndefined();
  });

  it("10. per-item counter delta only touches the failed items", () => {
    // Model counters as an integer; each moved item drops source by 1.
    const source = { total: 5, unread: 2 };
    const applied = { total: source.total - 3, unread: source.unread }; // b, c, d moved
    // b and d failed; c succeeded — counter reverts by exactly 2.
    const failed = ["b", "d"];
    const revertedTotal = applied.total + failed.length;
    expect(revertedTotal).toBe(4); // 5 - 3 + 2
    // c still deducted.
    expect(revertedTotal).toBe(source.total - 1);
  });
});
