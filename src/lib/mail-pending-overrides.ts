// Pure helpers for "pending flag overrides" and "pending hidden ids".
//
// Problem: a Star/Read mutation is optimistic on the client, but any list
// arriving from the Local Mail Index, Bridge, background sync, pagination,
// or deep search may still carry the OLD flag value for a short window. If
// we just replace state with the incoming list, the optimistic star flips
// back to empty until the next reload.
//
// Fix (flags): keep a small map of expected flag values keyed by message id.
// Every server-fetched list is piped through `applyOverrides` before it
// becomes state, so stale rows are patched with the user's intended value.
// Entries are GC'd via `reconcileOverrides` once a fresh row confirms the
// value.
//
// Fix (hidden rows): a companion map of message ids that were optimistically
// REMOVED from the currently-visible list (e.g. unstar inside the "starred"
// folder). Every server-list writer filters through `applyHidden` so a racing
// sync cannot resurrect a row the user just removed.
//
// Hidden lifecycle (V3):
//   * hideId(id)                  — enters `pending` (mutation in flight).
//   * unhideId(id)                — drops the entry (rollback / re-star).
//   * confirmHide(id, confirmedAt)— mutation succeeded; entry becomes
//                                    `confirmed`. It STAYS active so a racing
//                                    pre-mutation list can't resurrect the
//                                    row, then is dropped by
//                                    `gcHiddenBefore(cutoff)` on the next
//                                    list load that started AFTER confirmedAt.
//   * gcHiddenBefore(cutoff)      — drops every entry whose `confirmedAt` is
//                                    <= cutoff. Pending entries are kept.
//
// This module is intentionally dependency-free so it can be unit-tested in
// isolation and reused from any UI surface (list / deep search / cache).
import type { MailMessage } from "@/lib/mail-types";

export interface FlagOverride {
  starred?: boolean;
  read?: boolean;
}

export type OverridesMap = Map<string, FlagOverride>;

/** Apply overrides to a list (pure — returns a new array). */
export function applyOverrides(list: MailMessage[], overrides: OverridesMap): MailMessage[] {
  if (overrides.size === 0) return list;
  return list.map((m) => applyOverrideToOne(m, overrides));
}

/** Apply overrides to a single message (pure). */
export function applyOverrideToOne(m: MailMessage, overrides: OverridesMap): MailMessage {
  const o = overrides.get(m.id);
  if (!o) return m;
  if (o.starred === undefined && o.read === undefined) return m;
  return {
    ...m,
    ...(o.starred !== undefined ? { starred: o.starred } : {}),
    ...(o.read !== undefined ? { read: o.read } : {}),
  };
}

/** Set (or merge) an override entry. Mutates the map in place. */
export function setOverride(
  overrides: OverridesMap,
  id: string,
  patch: FlagOverride,
): OverridesMap {
  const existing = overrides.get(id) ?? {};
  overrides.set(id, { ...existing, ...patch });
  return overrides;
}

/** Clear a single field; drop the entry when empty. */
export function clearOverrideField(
  overrides: OverridesMap,
  id: string,
  field: keyof FlagOverride,
): void {
  const existing = overrides.get(id);
  if (!existing) return;
  const next: FlagOverride = { ...existing };
  delete next[field];
  if (next.starred === undefined && next.read === undefined) overrides.delete(id);
  else overrides.set(id, next);
}

/** Clear the whole entry (used on mutation failure rollback). */
export function clearOverride(overrides: OverridesMap, id: string): void {
  overrides.delete(id);
}

/**
 * GC pass: drop override fields where the incoming raw row already matches
 * the expected value. Safe to call on every server-list arrival — no-op if
 * there is drift, keeping the override until the server catches up.
 * Mutates `overrides` in place.
 */
export function reconcileOverrides(list: MailMessage[], overrides: OverridesMap): void {
  if (overrides.size === 0) return;
  for (const m of list) {
    const o = overrides.get(m.id);
    if (!o) continue;
    if (o.starred !== undefined && m.starred === o.starred) {
      clearOverrideField(overrides, m.id, "starred");
    }
    if (o.read !== undefined && m.read === o.read) {
      clearOverrideField(overrides, m.id, "read");
    }
  }
}

// ==============================================================
// Hidden ids (V3 lifecycle)
// ==============================================================

export type HideStatus =
  | { status: "pending" }
  | { status: "confirmed"; confirmedAt: number };

/** Map<id, HideStatus>. Keyed by the ORIGINAL message id (folder:uid). */
export type HiddenIdsMap = Map<string, HideStatus>;

/**
 * Backward-compat alias. Callers can pass either a plain Set<string> or the
 * V3 map; `applyHidden` accepts both via the `HiddenIdsLike` type below.
 */
export type HiddenIdsSet = HiddenIdsMap;

export type HiddenIdsLike = HiddenIdsMap | Set<string>;

function hiddenHas(hidden: HiddenIdsLike, id: string): boolean {
  return hidden.has(id);
}

export function applyHidden(list: MailMessage[], hidden: HiddenIdsLike): MailMessage[] {
  if (hidden.size === 0) return list;
  return list.filter((m) => !hiddenHas(hidden, m.id));
}

/** Mark an id as hidden (mutation in flight). Idempotent. */
export function hideId(hidden: HiddenIdsLike, id: string): void {
  if (hidden instanceof Set) {
    hidden.add(id);
    return;
  }
  hidden.set(id, { status: "pending" });
}

/** Drop the hide entirely (rollback OR re-star flow). */
export function unhideId(hidden: HiddenIdsLike, id: string): void {
  hidden.delete(id);
}

/**
 * Mark a hide as confirmed at `confirmedAt`. It stays active until a list
 * load started AFTER `confirmedAt` completes; `gcHiddenBefore` then drops it.
 */
export function confirmHide(hidden: HiddenIdsMap, id: string, confirmedAt: number): void {
  hidden.set(id, { status: "confirmed", confirmedAt });
}

/**
 * Drop every confirmed entry whose `confirmedAt <= cutoff`. Pending entries
 * are always retained (their mutation hasn't finished yet).
 *
 * Call this AFTER a successful primary list load, passing the timestamp
 * captured BEFORE the load was issued. Any hide confirmed before that
 * timestamp is guaranteed to be reflected by this list — safe to drop.
 * Returns the number of entries removed (for tests).
 */
export function gcHiddenBefore(hidden: HiddenIdsMap, cutoff: number): number {
  if (hidden.size === 0) return 0;
  let removed = 0;
  for (const [id, entry] of hidden) {
    if (entry.status === "confirmed" && entry.confirmedAt <= cutoff) {
      hidden.delete(id);
      removed++;
    }
  }
  return removed;
}
