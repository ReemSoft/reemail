export interface LatestMessageOpenTrackerOptions {
  maxScopes?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export interface MessageOpenIntentLease {
  isCurrent(): boolean;
}

interface LatestIntent {
  generation: number;
  messageIdentity: string;
  touchedAt: number;
}

const DEFAULT_MAX_SCOPES = 256;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/**
 * Bounded, request-local coordination for interactive message opens. It keeps
 * no message bytes and performs no I/O. Entries expire opportunistically, so
 * there is no timer or background scanner on the Bridge.
 */
export class LatestMessageOpenTracker {
  private readonly latest = new Map<string, LatestIntent>();
  private readonly maxScopes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: LatestMessageOpenTrackerOptions = {}) {
    this.maxScopes = Math.max(1, options.maxScopes ?? DEFAULT_MAX_SCOPES);
    this.maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.now = options.now ?? (() => Date.now());
  }

  register(scopeKey: string, generation: number, messageIdentity: string): MessageOpenIntentLease {
    const now = this.now();
    this.prune(now);
    const previous = this.latest.get(scopeKey);
    if (!previous || generation >= previous.generation) {
      this.latest.delete(scopeKey);
      this.latest.set(scopeKey, { generation, messageIdentity, touchedAt: now });
    }
    this.enforceBound();
    return {
      // Capacity/TTL eviction must degrade to the unchanged behavior rather
      // than cancel a legitimate open. Only a retained, newer identity can
      // prove that this operation is obsolete.
      isCurrent: () => {
        const current = this.latest.get(scopeKey);
        return !current || current.messageIdentity === messageIdentity;
      },
    };
  }

  stats(): { scopes: number } {
    this.prune(this.now());
    return { scopes: this.latest.size };
  }

  private prune(now: number): void {
    for (const [key, intent] of this.latest) {
      if (now - intent.touchedAt > this.maxAgeMs) this.latest.delete(key);
    }
  }

  private enforceBound(): void {
    while (this.latest.size > this.maxScopes) {
      const oldest = this.latest.keys().next().value as string | undefined;
      if (!oldest) return;
      this.latest.delete(oldest);
    }
  }
}

/** Active-only single-flight; entries are removed exactly when work settles. */
export class MessageOpenSingleFlight<T> {
  private readonly active = new Map<string, Promise<T>>();

  run(key: string, worker: () => Promise<T>): Promise<{ value: T; leader: boolean }> {
    const existing = this.active.get(key);
    if (existing) return existing.then((value) => ({ value, leader: false }));
    const promise = worker().finally(() => {
      if (this.active.get(key) === promise) this.active.delete(key);
    });
    this.active.set(key, promise);
    return promise.then((value) => ({ value, leader: true }));
  }

  stats(): { active: number } {
    return { active: this.active.size };
  }
}
