// Pure per-item rollback helpers for mail mutations (Batch B).
//
// Contract:
//   * On IMAP failure we NEVER rebuild the full list from a stale snapshot.
//   * Only the failed item is revived, at its ORIGINAL index, with a
//     duplicate guard — a concurrent mutation that already re-added the row
//     must not be clobbered.
//   * Successful items stay successful; concurrent unrelated changes stay.
//
// The mail route uses these helpers behind React state setters. They are
// pure so the semantics can be unit-tested without a DOM.

export interface HasId {
  id: string;
}

/** Re-insert `original` into `list` at `originalIndex`, skipping duplicates. */
export function reviveAt<T extends HasId>(
  list: readonly T[],
  original: T,
  originalIndex: number,
): T[] {
  if (list.some((m) => m.id === original.id)) return list.slice();
  const next = list.slice();
  const insertAt = Math.min(Math.max(originalIndex, 0), next.length);
  next.splice(insertAt, 0, original);
  return next;
}

export interface ItemSnapshot<T extends HasId> {
  original: T;
  originalIndex: number;
}

/**
 * Bulk per-item revive: only the ids in `failedIds` are restored, each at
 * their original index, with a duplicate guard applied per id. Items that
 * are neither failed nor already present are left alone (they succeeded).
 */
export function reviveFailed<T extends HasId>(
  list: readonly T[],
  snapshots: Map<string, ItemSnapshot<T>>,
  failedIds: Iterable<string>,
): T[] {
  let out = list.slice();
  // Iterate in ascending originalIndex so successive inserts don't shift
  // earlier items past their intended slot.
  const failedArr = Array.from(failedIds)
    .map((id) => snapshots.get(id))
    .filter((s): s is ItemSnapshot<T> => !!s)
    .sort((a, b) => a.originalIndex - b.originalIndex);
  for (const s of failedArr) {
    out = reviveAt(out, s.original, s.originalIndex);
  }
  return out;
}
