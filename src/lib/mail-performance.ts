type PerfValue = string | number | boolean;

export function mailPerf(event: string, fields: Record<string, PerfValue> = {}): void {
  if (!import.meta.env.DEV) return;
  try {
    console.debug(`[mail-perf] ${event}`, fields);
  } catch {
    /* diagnostics must never affect mail */
  }
}
