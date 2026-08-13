export const MAX_PERSISTED_THREAD_REFERENCES = 100;

/** Conservative RFC Message-ID normalization shared by app threading and ingestion. */
export function normalizePersistedThreadIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!/^[^<>\s@]+@[^<>\s@]+$/.test(inner)) return null;
  return `<${inner}>`;
}

/** Keep first-seen valid identities, preserving order and applying the persistent bound. */
export function normalizePersistedReferenceIds(values: readonly unknown[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const id = normalizePersistedThreadIdentity(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length === MAX_PERSISTED_THREAD_REFERENCES) break;
  }
  return normalized;
}
