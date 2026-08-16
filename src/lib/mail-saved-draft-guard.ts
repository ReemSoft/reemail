// Just-saved Draft readability guard (MAILMAESTRO_SAVED_DRAFT_READABILITY).
//
// A first NOT_FOUND for the exact Draft that was just successfully saved in
// this browser session is NOT sufficient evidence to tombstone it — the
// provider (e.g. Gmail) may not yet expose the freshly-APPENDed UID to another
// IMAP connection. This pure, UI-agnostic module owns the transient identity
// map + recovery-attempt tracking so that exact match can be unit-tested.
//
// No localStorage, no DB, no timestamps, no TTL. State lives in memory for the
// lifetime of the current browser session and is keyed by (accountId + draftId)
// with the value being the CURRENT canonical remote identity. Re-saving the
// same draftId REPLACES the old identity (never a growing set of stale UIDs).
export interface SavedDraftIdentity {
  accountId: string;
  draftId: string;
  folderPath: string;
  uidValidity: string;
  uid: number;
}

export interface SavedDraftGuard {
  /** Upsert: record/replace the current remote identity for a draftId. */
  record(identity: SavedDraftIdentity): void;
  /** Exact match on (accountId + uidValidity + uid). */
  find(accountId: string, uidValidity: string, uid: number): SavedDraftIdentity | null;
  /** Clear a specific draft (explicit delete/discard/send). */
  clearDraft(accountId: string, draftId: string): void;
  /** Clear every identity for one account (account switch). */
  clearAccount(accountId: string): void;
  /** Clear everything (session/account teardown). */
  clearAll(): void;
  /** Record that an automatic incremental+retry recovery was attempted. */
  markRecoveryAttempted(identity: SavedDraftIdentity): void;
  /** Whether an automatic recovery was already attempted for this identity. */
  hasRecoveryAttempted(identity: SavedDraftIdentity): boolean;
}

function draftKey(accountId: string, draftId: string): string {
  return `${accountId}|${draftId}`;
}

function recoveryKey(identity: SavedDraftIdentity): string {
  return `${identity.accountId}|${identity.draftId}|${identity.folderPath}|${identity.uidValidity}|${identity.uid}`;
}

function isValidIdentity(identity: SavedDraftIdentity): boolean {
  return (
    identity.accountId.length > 0 &&
    identity.draftId.length > 0 &&
    identity.folderPath.length > 0 &&
    identity.uidValidity.length > 0 &&
    Number.isInteger(identity.uid) &&
    identity.uid > 0
  );
}

export function createSavedDraftGuard(): SavedDraftGuard {
  const byDraft = new Map<string, SavedDraftIdentity>();
  const recoveryAttempted = new Set<string>();

  return {
    record(identity) {
      if (!isValidIdentity(identity)) return;
      byDraft.set(draftKey(identity.accountId, identity.draftId), identity);
    },
    find(accountId, uidValidity, uid) {
      for (const identity of byDraft.values()) {
        if (
          identity.accountId === accountId &&
          identity.uidValidity === uidValidity &&
          identity.uid === uid
        ) {
          return identity;
        }
      }
      return null;
    },
    clearDraft(accountId, draftId) {
      byDraft.delete(draftKey(accountId, draftId));
    },
    clearAccount(accountId) {
      for (const key of [...byDraft.keys()]) {
        if (key.startsWith(`${accountId}|`)) byDraft.delete(key);
      }
    },
    clearAll() {
      byDraft.clear();
      recoveryAttempted.clear();
    },
    markRecoveryAttempted(identity) {
      recoveryAttempted.add(recoveryKey(identity));
    },
    hasRecoveryAttempted(identity) {
      return recoveryAttempted.has(recoveryKey(identity));
    },
  };
}
