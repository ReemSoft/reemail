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
  /**
   * Record that a confirmed remote save replaced `previousIdentity` with
   * `currentIdentity` for the same draftId. The old identity becomes a stale
   * alias that resolves directly to the current identity. In-memory only.
   */
  recordReplacement(previousIdentity: SavedDraftIdentity, currentIdentity: SavedDraftIdentity): void;
  /** Exact match on (accountId + uidValidity + uid). */
  find(accountId: string, uidValidity: string, uid: number): SavedDraftIdentity | null;
  /**
   * Resolve a possibly-stale Draft identity to its current identity.
   * Returns null when the exact identity is not stale, is already current,
   * or is not a Draft alias.
   */
  findStale(accountId: string, uidValidity: string, uid: number): SavedDraftIdentity | null;
  /**
   * Track an exact Draft identity that is currently in flight. Used to keep a
   * stale alias alive until the operation can no longer mutate UI.
   */
  markInFlight(accountId: string, uidValidity: string, uid: number): void;
  /**
   * Release an exact Draft identity and prune its alias immediately when an
   * already-completed authoritative refresh made that identity obsolete.
   */
  releaseInFlight(accountId: string, uidValidity: string, uid: number): void;
  /**
   * Record the current authoritative Draft UIDs for (accountId, uidValidity)
   * and prune every stale alias that is no longer authoritative and has no
   * in-flight operation referencing it.
   */
  pruneAfterAuthoritativeRefresh(
    accountId: string,
    uidValidity: string,
    uids: ReadonlySet<number>,
  ): void;
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

function staleAliasKey(accountId: string, uidValidity: string, uid: number): string {
  return `${accountId}|${uidValidity}|${uid}`;
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
  const staleAliases = new Map<string, string>();
  const inFlightByAliasKey = new Map<string, number>();
  const authoritativeDraftUids = new Map<string, { uidValidity: string; uids: Set<number> }>();
  const recoveryAttempted = new Set<string>();

  const pruneAccountUidValidity = (accountId: string, uidValidity: string) => {
    const prefix = `${accountId}|${uidValidity}|`;
    const authoritative = authoritativeDraftUids.get(`${accountId}|${uidValidity}`);
    if (!authoritative) return;
    for (const [key] of staleAliases) {
      if (!key.startsWith(prefix)) continue;
      const uid = Number(key.slice(prefix.length));
      if (!Number.isFinite(uid)) continue;
      const inflight = inFlightByAliasKey.get(key) ?? 0;
      if (inflight > 0) continue;
      if (!authoritative.uids.has(uid)) staleAliases.delete(key);
    }
  };

  return {
    record(identity) {
      if (!isValidIdentity(identity)) return;
      byDraft.set(draftKey(identity.accountId, identity.draftId), identity);
    },
    recordReplacement(previousIdentity, currentIdentity) {
      if (!isValidIdentity(previousIdentity) || !isValidIdentity(currentIdentity)) return;
      if (previousIdentity.accountId !== currentIdentity.accountId) return;
      if (previousIdentity.draftId !== currentIdentity.draftId) return;
      byDraft.set(draftKey(currentIdentity.accountId, currentIdentity.draftId), currentIdentity);
      if (previousIdentity.uid !== currentIdentity.uid) {
        staleAliases.set(
          staleAliasKey(
            previousIdentity.accountId,
            previousIdentity.uidValidity,
            previousIdentity.uid,
          ),
          previousIdentity.draftId,
        );
      }
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
    findStale(accountId, uidValidity, uid) {
      const draftId = staleAliases.get(staleAliasKey(accountId, uidValidity, uid));
      if (!draftId) return null;
      const current = byDraft.get(draftKey(accountId, draftId));
      if (!current || !isValidIdentity(current)) return null;
      if (current.uidValidity !== uidValidity || current.uid === uid) return null;
      return current;
    },
    markInFlight(accountId, uidValidity, uid) {
      const key = staleAliasKey(accountId, uidValidity, uid);
      inFlightByAliasKey.set(key, (inFlightByAliasKey.get(key) ?? 0) + 1);
    },
    releaseInFlight(accountId, uidValidity, uid) {
      const key = staleAliasKey(accountId, uidValidity, uid);
      const next = (inFlightByAliasKey.get(key) ?? 0) - 1;
      if (next <= 0) {
        inFlightByAliasKey.delete(key);
      } else {
        inFlightByAliasKey.set(key, next);
      }
      pruneAccountUidValidity(accountId, uidValidity);
    },
    pruneAfterAuthoritativeRefresh(accountId, uidValidity, uids) {
      authoritativeDraftUids.set(`${accountId}|${uidValidity}`, {
        uidValidity,
        uids: new Set(uids),
      });
      pruneAccountUidValidity(accountId, uidValidity);
    },
    clearDraft(accountId, draftId) {
      byDraft.delete(draftKey(accountId, draftId));
      for (const [key, value] of staleAliases) {
        if (value === draftId && key.startsWith(`${accountId}|`)) {
          staleAliases.delete(key);
          inFlightByAliasKey.delete(key);
        }
      }
    },
    clearAccount(accountId) {
      for (const key of [...byDraft.keys()]) {
        if (key.startsWith(`${accountId}|`)) byDraft.delete(key);
      }
      for (const key of [...staleAliases.keys()]) {
        if (key.startsWith(`${accountId}|`)) staleAliases.delete(key);
      }
      for (const key of [...inFlightByAliasKey.keys()]) {
        if (key.startsWith(`${accountId}|`)) inFlightByAliasKey.delete(key);
      }
      for (const key of [...authoritativeDraftUids.keys()]) {
        if (key.startsWith(`${accountId}|`)) authoritativeDraftUids.delete(key);
      }
    },
    clearAll() {
      byDraft.clear();
      staleAliases.clear();
      inFlightByAliasKey.clear();
      authoritativeDraftUids.clear();
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
