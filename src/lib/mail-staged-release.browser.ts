// Browser-only, best-effort release of staged attachment handles.
//
// Called only when the user genuinely abandons a staged resource: removing a
// normal attachment, removing an inline image, deleting a draft, or discarding
// the composer. It never throws and never blocks the UI — a failed release is
// harmless because unreachable staged files expire naturally by TTL.

export interface StagedReleaseResult {
  ok: boolean;
  released?: number;
  error?: string;
}

export async function releaseStagedHandles(
  mailSessionToken: string,
  handles: ReadonlyArray<string | undefined | null>,
): Promise<boolean> {
  const unique = [...new Set(handles.filter((h): h is string => typeof h === "string" && h.length > 0))];
  if (unique.length === 0 || !mailSessionToken) return false;
  try {
    const response = await fetch("/api/mail-staged-release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mailSessionToken, handles: unique }),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as StagedReleaseResult;
    return result.ok === true;
  } catch {
    return false;
  }
}
