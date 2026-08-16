// Pure sync-path resolution for the Local Mail Index background driver.
//
// Invariant (MAILMAESTRO_CANONICAL_SELFHEAL path provenance):
//   * authoritative Bridge/provider path  → trustedCanonical=true
//   * Local Index-derived path            → trustedCanonical=false
//     and MUST NEVER rewrite/repair canonical.
//
// A Local Index path is only ever usable for ordinary untrusted sync when its
// canonical appears EXACTLY once and the path is non-null. A duplicate
// canonical is ambiguous (corruption) and must never be resolved by array
// order / first() / substring guessing — it requires authoritative provider
// resolution before a canonical repair can happen.
import type { MailFolder } from "@/lib/mail-types";

/** Minimal structural subset of the Local Index counts rows. */
export interface IndexFolderPathRow {
  folder: MailFolder;
  path: string | null;
}

export interface SyncPathResolution {
  /** Physical path handed to the sync engine, or null when unavailable. */
  syncPath: string | null;
  /** True only when syncPath is the authoritative (Bridge-resolved) path. */
  pathTrusted: boolean;
  /** Unique non-ambiguous Local Index path for the folder, or null. */
  uniqueIndexPath: string | null;
}

/**
 * Derive the unique non-ambiguous Local Index physical path for a canonical.
 *
 * Returns null when the canonical is missing, appears more than once
 * (ambiguous), or has no physical path. Never uses array order to break a tie.
 */
export function uniqueNonAmbiguousIndexPath(
  indexCounts: IndexFolderPathRow[],
  folder: MailFolder,
): string | null {
  let occurrences = 0;
  let path: string | null = null;
  for (const row of indexCounts) {
    if (row.folder !== folder) continue;
    occurrences += 1;
    if (row.path) path = row.path;
  }
  if (occurrences !== 1) return null;
  return path;
}

/**
 * Resolve the sync path and its trust provenance.
 *
 *   syncPath   = authoritativePath ?? uniqueNonAmbiguousIndexPath ?? null
 *   pathTrusted = authoritativePath != null && syncPath === authoritativePath
 *
 * An index-derived path is never trusted (trustedCanonical stays false), so it
 * can never authorize a canonical self-heal reassignment.
 */
export function resolveSyncPath(
  authoritativePath: string | null,
  indexCounts: IndexFolderPathRow[],
  folder: MailFolder,
): SyncPathResolution {
  const uniqueIndexPath = uniqueNonAmbiguousIndexPath(indexCounts, folder);
  const syncPath = authoritativePath ?? uniqueIndexPath ?? null;
  const pathTrusted = authoritativePath != null && syncPath === authoritativePath;
  return { syncPath, pathTrusted, uniqueIndexPath };
}
