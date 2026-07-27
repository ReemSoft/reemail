// BLOCKER_6 — Account-scoped restore-origin tracker.
//
// The origin map remembers "when this thread went to Trash, it came from
// <folder>", so Restore returns it there. It MUST be scoped by account:
// two accounts can independently trash a thread whose id/Message-ID happens
// to collide, and each restore must pick the origin recorded FOR THAT
// ACCOUNT — not whichever was written last.
//
// Pure module: no React, no side effects at import time. Callers pass their
// storage getter/setter and the active `accountId`. Legacy unscoped entries
// under the historical single-key storage are ignored (never returned).
//
// Persistence key layout:
//   mailmaestro:trash-origin:v2:<accountId> -> { [threadId]: MailFolder }
// A single call to `clearAccountOrigins(accountId)` wipes just that
// account's map on sign-out.

import type { MailFolder } from "@/lib/mail-types";
export type { MailFolder };


export interface OriginStorage {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
}

const KEY_PREFIX = "mailmaestro:trash-origin:v2:";
const DEFAULT_ORIGIN: MailFolder = "inbox";

function key(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

function load(storage: OriginStorage, accountId: string): Record<string, MailFolder> {
  try {
    const raw = storage.getItem(key(accountId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, MailFolder>;
  } catch {
    return {};
  }
}

function save(storage: OriginStorage, accountId: string, map: Record<string, MailFolder>): void {
  try {
    storage.setItem(key(accountId), JSON.stringify(map));
  } catch {
    /* quota — ignore */
  }
}

export function rememberOrigin(
  storage: OriginStorage,
  accountId: string | null,
  threadId: string | undefined,
  folder: MailFolder,
): void {
  if (!accountId || !threadId || folder === "trash") return;
  const m = load(storage, accountId);
  if (m[threadId] === folder) return; // no-op write
  m[threadId] = folder;
  save(storage, accountId, m);
}

export function getOrigin(
  storage: OriginStorage,
  accountId: string | null,
  threadId: string | undefined,
): MailFolder {
  if (!accountId || !threadId) return DEFAULT_ORIGIN;
  const m = load(storage, accountId);
  return m[threadId] ?? DEFAULT_ORIGIN;
}

export function forgetOrigin(
  storage: OriginStorage,
  accountId: string | null,
  threadId: string | undefined,
): void {
  if (!accountId || !threadId) return;
  const m = load(storage, accountId);
  if (!(threadId in m)) return;
  delete m[threadId];
  save(storage, accountId, m);
}

export function clearAccountOrigins(
  storage: OriginStorage,
  accountId: string | null,
): void {
  if (!accountId) return;
  storage.removeItem(key(accountId));
}

// Exported for tests that need to seed cross-account fixtures.
export const __originKey = key;
