export const MAX_THREAD_REFERENCES = 100;

export function normalizeRfcMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!/^[^<>\s@]+@[^<>\s@]+$/.test(inner)) return null;
  return `<${inner}>`;
}

export function normalizeThreadingHeaders(
  inReplyTo: unknown,
  references: readonly unknown[] | undefined,
): { inReplyTo?: string; references?: string[] } {
  const parent = normalizeRfcMessageId(inReplyTo);
  if (!parent) return {};
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const candidate of references ?? []) {
    const normalized = normalizeRfcMessageId(candidate);
    if (!normalized || normalized === parent || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  ordered.push(parent);
  const bounded =
    ordered.length <= MAX_THREAD_REFERENCES
      ? ordered
      : [ordered[0], ...ordered.slice(-(MAX_THREAD_REFERENCES - 1))];
  return { inReplyTo: parent, references: bounded };
}
