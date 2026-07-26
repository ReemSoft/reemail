/**
 * Non-blocking concurrency gate for outbound send operations.
 *
 * Uses `tryAcquire` semantics — callers that hit the cap get a synchronous
 * `false` and the endpoint returns `SEND_BUSY`. No internal queue means a
 * traffic spike cannot silently pin memory waiting on turns.
 *
 * Two independent gates:
 *   * global   — protects the bridge process from an aggregate flood.
 *   * per-key  — protects a single mailbox from a runaway client.
 *
 * The per-key counter self-cleans when it hits zero so the map cannot grow
 * unbounded across millions of unique accounts over the process lifetime.
 */

export interface SendGates {
  tryAcquire(key: string): boolean;
  release(key: string): void;
  /** Current global in-flight count. Exposed for tests / diagnostics. */
  inFlight(): number;
}

export interface SendGatesConfig {
  globalMax: number;
  perKeyMax: number;
}

export function createSendGates(cfg: SendGatesConfig): SendGates {
  let global = 0;
  const perKey = new Map<string, number>();
  return {
    tryAcquire(key) {
      if (global >= cfg.globalMax) return false;
      const cur = perKey.get(key) ?? 0;
      if (cur >= cfg.perKeyMax) return false;
      perKey.set(key, cur + 1);
      global++;
      return true;
    },
    release(key) {
      const cur = perKey.get(key) ?? 0;
      if (cur <= 1) perKey.delete(key);
      else perKey.set(key, cur - 1);
      if (global > 0) global--;
    },
    inFlight() {
      return global;
    },
  };
}
