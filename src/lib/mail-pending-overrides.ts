// Pure helpers for "pending flag overrides".
//
// Problem: a Star/Read mutation is optimistic on the client, but any list
// arriving from the Local Mail Index, Bridge, background sync, pagination,
// or deep search may still carry the OLD flag value for a short window. If
// we just replace state with the incoming list, the optimistic star flips
// back to empty until the next reload.
//
// Fix: keep a small map of expected flag values keyed by message id. Every
// server-fetched list is piped through `applyOverrides` before it becomes
// state, so stale rows are patched with the user's intended value. Entries
// are GC'd via `reconcileOverrides` once a fresh row confirms the value.
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

/**
 * Hidden-ids set: message IDs that were optimistically removed from the
 * currently-visible list (e.g. unstar inside the "starred" folder). Every
 * server-list writer must filter through `applyHidden` so a racing sync
 * cannot resurrect a row the user just removed.
 *
 * On mutation failure the caller unhides + restores the snapshot in place.
 * On success the entry stays until a fresh reload naturally drops the row
 * (server no longer returns it) — cheap and self-healing.
 */
export type HiddenIdsSet = Set<string>;

export function applyHidden(list: MailMessage[], hidden: HiddenIdsSet): MailMessage[] {
  if (hidden.size === 0) return list;
  return list.filter((m) => !hidden.has(m.id));
}

export function hideId(hidden: HiddenIdsSet, id: string): void {
  hidden.add(id);
}

export function unhideId(hidden: HiddenIdsSet, id: string): void {
  hidden.delete(id);
}
