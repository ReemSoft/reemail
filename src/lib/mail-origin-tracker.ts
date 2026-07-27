// BLOCKER_C — Trash Origin Identity tracker (v3).
//
// Restore reads its target from an entry keyed by the PHYSICAL identity of
// the message inside the Trash folder — not by threadId, not by Message-ID.
// A single account can safely trash two messages that share a threadId or
// Message-ID, each with its own origin, because the key is:
//
//   (accountId, trashUidValidity, trashUid)
//
// When we move a message to Trash and IMAP succeeds we capture the trash
// identity from either:
//   1. Bridge UIDPLUS (`move.destinationUid` + `destinationUidValidity`), or
//   2. Targeted Destination Sync (`discoveredDestinationUid` + validity).
// Only then a FINAL origin is written.
//
// If IMAP succeeded but neither identity is available yet, a PENDING origin
// is written keyed by the physical SOURCE identity, and later promoted to a
// FINAL origin by `promotePendingOriginToFinal` when the trash identity
// becomes known. Pending entries are NEVER expired on a timer.
//
// Two independent per-account storage keys:
//   mailmaestro:trash-origin:v3:<accountId>          -> final map
//   mailmaestro:trash-pending-origin:v3:<accountId>  -> pending map
//
// The module is pure (no React, no globals, storage is injected) so it can
// be unit-tested and reused. Legacy v1/v2 unscoped entries are never read.

import type { MailFolder } from "@/lib/mail-types";
export type { MailFolder };

export interface OriginStorage {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
}

/**
 * Destination folder kind for a Restore-capable Move. Origins are stored in
 * separate namespaces per kind so a Trash origin can never collide with an
 * Archive origin even when both destinations expose the same physical UID
 * across two mailboxes.
 *
 * The default value is `"trash"` so pre-existing callers, tests, and the
 * on-disk storage keys (`mailmaestro:trash-origin:v3:*`) continue to work
 * byte-identically without migration.
 */
export type OriginKind = "trash" | "archive";

// -------- Types --------

export interface FinalOriginKey {
  accountId: string;
  /**
   * UIDVALIDITY of the DESTINATION folder (Trash for kind="trash", Archive
   * for kind="archive"). Field name kept for backward-compat.
   */
  trashUidValidity: number;
  /**
   * UID inside the DESTINATION folder (Trash/Archive per kind). Field name
   * kept for backward-compat.
   */
  trashUid: number;
}

export interface FinalOriginEntry {
  originalCanonical: MailFolder;
  originalPath?: string | null;
  messageId?: string | null;
}

export interface PendingSourceKey {
  accountId: string;
  /** Physical source folder (e.g. `inbox`, `archive`) — caller normalizes. */
  sourceCanonical: string;
  sourceUid: number;
  sourceUidValidity?: number;
}

export interface PendingOriginEntry {
  sourceCanonical: string;
  sourceUid: number;
  sourceUidValidity?: number;
  originalCanonical: MailFolder;
  originalPath?: string | null;
  messageId?: string | null;
  fingerprint?: string | null;
  createdAt: number;
}

// -------- Key builders --------

function finalStorageKey(accountId: string, kind: OriginKind = "trash"): string {
  return `mailmaestro:${kind}-origin:v3:${accountId}`;
}
function pendingStorageKey(accountId: string, kind: OriginKind = "trash"): string {
  return `mailmaestro:${kind}-pending-origin:v3:${accountId}`;
}
function finalEntryKey(uv: number, uid: number): string {
  return `${uv}:${uid}`;
}
function pendingEntryKey(
  sourceCanonical: string,
  sourceUid: number,
  sourceUidValidity?: number,
): string {
  return `${sourceCanonical}:${sourceUid}:${sourceUidValidity ?? "?"}`;
}

// -------- Low-level I/O --------

function loadFinal(storage: OriginStorage, accountId: string): Record<string, FinalOriginEntry> {
  try {
    const raw = storage.getItem(finalStorageKey(accountId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, FinalOriginEntry>;
  } catch {
    return {};
  }
}
function saveFinal(
  storage: OriginStorage,
  accountId: string,
  map: Record<string, FinalOriginEntry>,
): void {
  try {
    storage.setItem(finalStorageKey(accountId), JSON.stringify(map));
  } catch {
    /* quota — ignore */
  }
}
function loadPending(
  storage: OriginStorage,
  accountId: string,
): Record<string, PendingOriginEntry> {
  try {
    const raw = storage.getItem(pendingStorageKey(accountId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, PendingOriginEntry>;
  } catch {
    return {};
  }
}
function savePending(
  storage: OriginStorage,
  accountId: string,
  map: Record<string, PendingOriginEntry>,
): void {
  try {
    storage.setItem(pendingStorageKey(accountId), JSON.stringify(map));
  } catch {
    /* quota — ignore */
  }
}

// -------- Public API --------

/**
 * Write a FINAL origin. The `originalCanonical` MUST NOT be `"trash"` (that
 * would mean "restore back to trash" — nonsensical).
 */
export function rememberFinalOrigin(
  storage: OriginStorage,
  key: FinalOriginKey,
  entry: FinalOriginEntry,
): void {
  if (
    !key.accountId ||
    !Number.isFinite(key.trashUidValidity) ||
    key.trashUidValidity <= 0 ||
    !Number.isFinite(key.trashUid) ||
    key.trashUid <= 0
  )
    return;
  if (entry.originalCanonical === "trash") return;
  const map = loadFinal(storage, key.accountId);
  const k = finalEntryKey(key.trashUidValidity, key.trashUid);
  const prev = map[k];
  if (
    prev &&
    prev.originalCanonical === entry.originalCanonical &&
    (prev.originalPath ?? null) === (entry.originalPath ?? null) &&
    (prev.messageId ?? null) === (entry.messageId ?? null)
  ) {
    return; // no-op write
  }
  map[k] = {
    originalCanonical: entry.originalCanonical,
    originalPath: entry.originalPath ?? null,
    messageId: entry.messageId ?? null,
  };
  saveFinal(storage, key.accountId, map);
}

export function rememberPendingOrigin(
  storage: OriginStorage,
  key: PendingSourceKey,
  entry: Omit<PendingOriginEntry, "sourceCanonical" | "sourceUid" | "sourceUidValidity">,
): void {
  if (
    !key.accountId ||
    !key.sourceCanonical ||
    !Number.isFinite(key.sourceUid) ||
    key.sourceUid <= 0
  )
    return;
  if (entry.originalCanonical === "trash") return;
  const map = loadPending(storage, key.accountId);
  const k = pendingEntryKey(key.sourceCanonical, key.sourceUid, key.sourceUidValidity);
  map[k] = {
    sourceCanonical: key.sourceCanonical,
    sourceUid: key.sourceUid,
    sourceUidValidity: key.sourceUidValidity,
    originalCanonical: entry.originalCanonical,
    originalPath: entry.originalPath ?? null,
    messageId: entry.messageId ?? null,
    fingerprint: entry.fingerprint ?? null,
    createdAt: entry.createdAt || Date.now(),
  };
  savePending(storage, key.accountId, map);
}

/**
 * Promote a pending origin (source-keyed) to a final origin (trash-keyed).
 * Returns the pending entry that was promoted, or `null` when no matching
 * pending entry exists. Deletes the pending entry on success.
 */
export function promotePendingOriginToFinal(
  storage: OriginStorage,
  source: PendingSourceKey,
  trash: { trashUidValidity: number; trashUid: number },
): FinalOriginEntry | null {
  if (
    !source.accountId ||
    !Number.isFinite(trash.trashUidValidity) ||
    trash.trashUidValidity <= 0 ||
    !Number.isFinite(trash.trashUid) ||
    trash.trashUid <= 0
  )
    return null;
  const pending = loadPending(storage, source.accountId);
  const pk = pendingEntryKey(source.sourceCanonical, source.sourceUid, source.sourceUidValidity);
  const entry = pending[pk];
  if (!entry) return null;
  const finalEntry: FinalOriginEntry = {
    originalCanonical: entry.originalCanonical,
    originalPath: entry.originalPath ?? null,
    messageId: entry.messageId ?? null,
  };
  rememberFinalOrigin(
    storage,
    {
      accountId: source.accountId,
      trashUidValidity: trash.trashUidValidity,
      trashUid: trash.trashUid,
    },
    finalEntry,
  );
  delete pending[pk];
  savePending(storage, source.accountId, pending);
  return finalEntry;
}

/** Look up the final origin for a Trash identity. Returns `null` when missing. */
export function getOrigin(storage: OriginStorage, key: FinalOriginKey): FinalOriginEntry | null {
  if (
    !key.accountId ||
    !Number.isFinite(key.trashUidValidity) ||
    key.trashUidValidity <= 0 ||
    !Number.isFinite(key.trashUid) ||
    key.trashUid <= 0
  )
    return null;
  const map = loadFinal(storage, key.accountId);
  return map[finalEntryKey(key.trashUidValidity, key.trashUid)] ?? null;
}

export function forgetFinalOrigin(storage: OriginStorage, key: FinalOriginKey): void {
  if (!key.accountId) return;
  const map = loadFinal(storage, key.accountId);
  const k = finalEntryKey(key.trashUidValidity, key.trashUid);
  if (!(k in map)) return;
  delete map[k];
  saveFinal(storage, key.accountId, map);
}

export function forgetPendingOrigin(storage: OriginStorage, key: PendingSourceKey): void {
  if (!key.accountId) return;
  const map = loadPending(storage, key.accountId);
  const k = pendingEntryKey(key.sourceCanonical, key.sourceUid, key.sourceUidValidity);
  if (!(k in map)) return;
  delete map[k];
  savePending(storage, key.accountId, map);
}

/**
 * Drop every final + pending origin that references `messageId`. Used on
 * successful Restore / Permanent Delete when the trash identity may or may
 * not be available on the caller (e.g. restore success after promotion).
 */
export function forgetOriginsForMessageId(
  storage: OriginStorage,
  accountId: string | null,
  messageId: string | null | undefined,
): number {
  if (!accountId || !messageId) return 0;
  let removed = 0;
  const finals = loadFinal(storage, accountId);
  let finalDirty = false;
  for (const k of Object.keys(finals)) {
    if ((finals[k].messageId ?? null) === messageId) {
      delete finals[k];
      removed++;
      finalDirty = true;
    }
  }
  if (finalDirty) saveFinal(storage, accountId, finals);
  const pendings = loadPending(storage, accountId);
  let pendingDirty = false;
  for (const k of Object.keys(pendings)) {
    if ((pendings[k].messageId ?? null) === messageId) {
      delete pendings[k];
      removed++;
      pendingDirty = true;
    }
  }
  if (pendingDirty) savePending(storage, accountId, pendings);
  return removed;
}

/**
 * Drop every FINAL entry whose `trashUidValidity` no longer matches the
 * server's current Trash UIDVALIDITY. Pending entries are NOT touched
 * (they hold a SOURCE identity, not a trash identity).
 */
export function purgeStaleTrashUidValidity(
  storage: OriginStorage,
  accountId: string | null,
  currentTrashUidValidity: number,
): number {
  if (!accountId || !Number.isFinite(currentTrashUidValidity) || currentTrashUidValidity <= 0) {
    return 0;
  }
  const map = loadFinal(storage, accountId);
  let removed = 0;
  let dirty = false;
  for (const k of Object.keys(map)) {
    const colon = k.indexOf(":");
    if (colon <= 0) continue;
    const uv = Number(k.slice(0, colon));
    if (!Number.isFinite(uv) || uv !== currentTrashUidValidity) {
      delete map[k];
      removed++;
      dirty = true;
    }
  }
  if (dirty) saveFinal(storage, accountId, map);
  return removed;
}

/** Wipe every v3 origin (final + pending) for `accountId`. */
export function clearAccountOrigins(storage: OriginStorage, accountId: string | null): void {
  if (!accountId) return;
  storage.removeItem(finalStorageKey(accountId));
  storage.removeItem(pendingStorageKey(accountId));
}

// -------- Fingerprint --------

/**
 * Build a conservative fingerprint from immutable fields that survive a
 * move to Trash. `messageId` participates but is NEVER the sole key — the
 * fingerprint must also incorporate other fields so two rows that happen
 * to share a Message-ID stay distinguishable.
 *
 * Returns an empty string when no meaningful signal is available; callers
 * MUST treat an empty fingerprint as "cannot match".
 */
export function buildOriginFingerprint(input: {
  messageId?: string | null;
  fromEmail?: string | null;
  subject?: string | null;
  date?: string | null;
  sizeBytes?: number | null;
}): string {
  const norm = (v: string | null | undefined) => (v ?? "").toString().trim().toLowerCase();
  const parts = [
    norm(input.messageId),
    norm(input.fromEmail),
    norm(input.subject),
    norm(input.date),
    input.sizeBytes != null && Number.isFinite(input.sizeBytes) ? String(input.sizeBytes) : "",
  ];
  // Require at least two non-empty components to avoid single-field collisions.
  const nonEmpty = parts.filter((p) => p.length > 0).length;
  if (nonEmpty < 2) return "";
  return parts.join("\u0001");
}

/**
 * Promote a pending origin to final when EXACTLY ONE pending entry for
 * this account matches the trashed message's fingerprint. Ambiguous
 * matches (0 or >1) are left alone — we never guess.
 *
 * Returns the promoted FinalOriginEntry, or `null` when no unique match.
 */
export function promoteUniquePendingOriginForTrashMessage(
  storage: OriginStorage,
  input: {
    accountId: string;
    trashUidValidity: number;
    trashUid: number;
    fingerprint: string;
  },
): FinalOriginEntry | null {
  if (
    !input.accountId ||
    !Number.isFinite(input.trashUidValidity) ||
    input.trashUidValidity <= 0 ||
    !Number.isFinite(input.trashUid) ||
    input.trashUid <= 0 ||
    !input.fingerprint
  )
    return null;
  const pending = loadPending(storage, input.accountId);
  // Skip if a final origin already exists for this trash identity — never
  // overwrite a stronger identity-based entry with a fingerprint guess.
  const finals = loadFinal(storage, input.accountId);
  if (finals[finalEntryKey(input.trashUidValidity, input.trashUid)]) return null;
  let matchKey: string | null = null;
  let matches = 0;
  for (const k of Object.keys(pending)) {
    if ((pending[k].fingerprint ?? "") === input.fingerprint) {
      matches++;
      matchKey = k;
      if (matches > 1) return null; // ambiguous
    }
  }
  if (matches !== 1 || !matchKey) return null;
  const entry = pending[matchKey];
  const finalEntry: FinalOriginEntry = {
    originalCanonical: entry.originalCanonical,
    originalPath: entry.originalPath ?? null,
    messageId: entry.messageId ?? null,
  };
  finals[finalEntryKey(input.trashUidValidity, input.trashUid)] = finalEntry;
  saveFinal(storage, input.accountId, finals);
  delete pending[matchKey];
  savePending(storage, input.accountId, pending);
  return finalEntry;
}

// -------- Test helpers --------

export const __finalStorageKey = finalStorageKey;
export const __pendingStorageKey = pendingStorageKey;
export const __finalEntryKey = finalEntryKey;
export const __pendingEntryKey = pendingEntryKey;
