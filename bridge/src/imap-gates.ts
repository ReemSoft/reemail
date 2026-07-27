/**
 * Central IMAP concurrency limiter (MAILMAESTRO_IMAP_LIMITER_R3).
 *
 * Enforces four independent caps around every IMAP operation:
 *   * global     — total in-flight IMAP operations across the process
 *   * per-host   — normalized imap_host (lowercase + trim)
 *   * per-company— logical tenant identifier
 *   * per-account— per-mailbox (email address, lowercased)
 *
 * Callers do one `acquire` per real IMAP connection and release in a
 * `finally` block. `release` is idempotent. Waiters use two FIFO queues
 * (interactive / background) with weighted fairness (3:1 preferring
 * interactive; background is reserved 25% of admissions so it cannot
 * starve). Overflow / timeout / cancellation all fail fast with an
 * `ImapBusyError` — callers translate that into HTTP 503 + `IMAP_BUSY`.
 *
 * Feature-flagged behind `IMAP_GATES_ENABLED`. When disabled every
 * `acquire` resolves immediately with a no-op release — behaviour is
 * bit-identical to the previous unlimited path.
 *
 * Bounded, side-effect-free metrics are exposed via `stats()`.
 * No secrets, no email addresses, no account/company identifiers are
 * ever included in metrics or logs.
 */

export type ImapPriority = "interactive" | "background";

export interface ImapGatesConfig {
  enabled: boolean;
  globalMax: number;
  perHostMax: number;
  perCompanyMax: number;
  perAccountMax: number;
  waitQueueMax: number;
  interactiveWaitTimeoutMs: number;
  backgroundWaitTimeoutMs: number;
}

export function normalizeHost(host: string): string {
  return String(host || "").trim().toLowerCase();
}

export function normalizeAccount(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function normalizeCompany(id: string | undefined | null): string {
  const v = String(id ?? "").trim().toLowerCase();
  return v.length > 0 ? v : "__default__";
}

export interface AcquireOptions {
  host: string;
  company: string;
  account: string;
  priority: ImapPriority;
  /** Optional per-call override; falls back to config timeout. */
  waitTimeoutMs?: number;
  /** Optional AbortSignal — used by HTTP handlers on client disconnect. */
  signal?: AbortSignal;
}

export interface ImapGateRelease {
  (): void;
}

export class ImapBusyError extends Error {
  readonly code = "IMAP_BUSY";
  readonly retryAfterSeconds: number;
  readonly reason: "queue-full" | "timeout" | "cancelled";
  constructor(reason: "queue-full" | "timeout" | "cancelled", retryAfterSeconds = 2) {
    super("IMAP_BUSY");
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Waiter {
  id: number;
  key: { host: string; company: string; account: string };
  priority: ImapPriority;
  enqueuedAtMs: number;
  resolve: (release: ImapGateRelease) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
  signal?: AbortSignal;
  settled: boolean;
}

interface Counters {
  admitted: number;
  rejectedQueueFull: number;
  timedOut: number;
  cancelled: number;
}

const HISTOGRAM_SIZE = 500;

export interface ImapGates {
  acquire(opts: AcquireOptions): Promise<ImapGateRelease>;
  stats(): ImapGateStats;
  /** Test-only: force-drain waiters and reset counters. */
  _reset(): void;
}

export interface ImapGateStats {
  enabled: boolean;
  activeGlobal: number;
  activeByHost: Record<string, number>;
  waitingInteractive: number;
  waitingBackground: number;
  admitted: number;
  rejected: number;
  timedOut: number;
  cancelled: number;
  waitMsP50: number;
  waitMsP95: number;
  limits: {
    globalMax: number;
    perHostMax: number;
    perCompanyMax: number;
    perAccountMax: number;
    waitQueueMax: number;
    interactiveWaitTimeoutMs: number;
    backgroundWaitTimeoutMs: number;
  };
}

export function createImapGates(cfg: ImapGatesConfig): ImapGates {
  let activeGlobal = 0;
  const activeByHost = new Map<string, number>();
  const activeByCompany = new Map<string, number>();
  const activeByAccount = new Map<string, number>();

  const waitingInteractive: Waiter[] = [];
  const waitingBackground: Waiter[] = [];

  // Weighted fairness: after this many consecutive interactive admissions,
  // force one background admission (if any waiting). Reset on background
  // admission or when interactive queue drains.
  const FAIRNESS_WEIGHT = 3;
  let interactiveStreak = 0;

  const counters: Counters = {
    admitted: 0,
    rejectedQueueFull: 0,
    timedOut: 0,
    cancelled: 0,
  };

  // Bounded rolling ring buffer of wait durations (ms). Never grows.
  const waitHist = new Float64Array(HISTOGRAM_SIZE);
  let waitHistCount = 0;
  let waitHistCursor = 0;

  let nextWaiterId = 1;

  function recordWait(ms: number): void {
    waitHist[waitHistCursor] = ms;
    waitHistCursor = (waitHistCursor + 1) % HISTOGRAM_SIZE;
    if (waitHistCount < HISTOGRAM_SIZE) waitHistCount++;
  }

  function percentile(p: number): number {
    if (waitHistCount === 0) return 0;
    const buf = new Float64Array(waitHistCount);
    for (let i = 0; i < waitHistCount; i++) buf[i] = waitHist[i];
    buf.sort();
    const idx = Math.min(waitHistCount - 1, Math.max(0, Math.floor((p / 100) * waitHistCount)));
    return Math.round(buf[idx]);
  }

  function inc(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  function dec(map: Map<string, number>, key: string): void {
    const cur = map.get(key) ?? 0;
    if (cur <= 1) map.delete(key);
    else map.set(key, cur - 1);
  }

  function canAdmitKey(key: { host: string; company: string; account: string }): boolean {
    if (activeGlobal >= cfg.globalMax) return false;
    if ((activeByHost.get(key.host) ?? 0) >= cfg.perHostMax) return false;
    if ((activeByCompany.get(key.company) ?? 0) >= cfg.perCompanyMax) return false;
    if ((activeByAccount.get(key.account) ?? 0) >= cfg.perAccountMax) return false;
    return true;
  }

  function admit(waiter: Waiter): ImapGateRelease {
    activeGlobal++;
    inc(activeByHost, waiter.key.host);
    inc(activeByCompany, waiter.key.company);
    inc(activeByAccount, waiter.key.account);
    counters.admitted++;
    recordWait(Math.max(0, Date.now() - waiter.enqueuedAtMs));

    let released = false;
    const release: ImapGateRelease = () => {
      if (released) return;
      released = true;
      if (activeGlobal > 0) activeGlobal--;
      dec(activeByHost, waiter.key.host);
      dec(activeByCompany, waiter.key.company);
      dec(activeByAccount, waiter.key.account);
      drain();
    };
    return release;
  }

  /** Pick the next waiter to admit, respecting per-key caps and fairness. */
  function pickNext(): Waiter | null {
    if (activeGlobal >= cfg.globalMax) return null;

    const interactiveEligible = firstEligible(waitingInteractive);
    const backgroundEligible = firstEligible(waitingBackground);

    if (!interactiveEligible && !backgroundEligible) return null;
    if (!interactiveEligible) return backgroundEligible;
    if (!backgroundEligible) return interactiveEligible;

    // Weighted fairness: after FAIRNESS_WEIGHT interactive admits in a row,
    // yield to a waiting background slot so it can never starve.
    if (interactiveStreak >= FAIRNESS_WEIGHT) return backgroundEligible;
    return interactiveEligible;
  }

  function firstEligible(queue: Waiter[]): Waiter | null {
    for (let i = 0; i < queue.length; i++) {
      const w = queue[i];
      if (w.settled) continue;
      if (canAdmitKey(w.key)) return w;
    }
    return null;
  }

  function removeFromQueue(waiter: Waiter): void {
    const queue = waiter.priority === "interactive" ? waitingInteractive : waitingBackground;
    const idx = queue.indexOf(waiter);
    if (idx >= 0) queue.splice(idx, 1);
  }

  function settleWaiter(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    if (waiter.onAbort && waiter.signal) {
      try { waiter.signal.removeEventListener("abort", waiter.onAbort); } catch { /* noop */ }
      waiter.onAbort = null;
    }
    removeFromQueue(waiter);
  }

  function drain(): void {
    // Loop: admit as many as possible respecting fairness + caps.
    // Bounded: pickNext returns null when no candidate can be admitted.
    let safety = 10_000;
    while (safety-- > 0) {
      const w = pickNext();
      if (!w) return;
      settleWaiter(w);
      const release = admit(w);
      if (w.priority === "interactive") interactiveStreak++;
      else interactiveStreak = 0;
      w.resolve(release);
    }
  }

  function acquire(opts: AcquireOptions): Promise<ImapGateRelease> {
    if (!cfg.enabled) {
      // Feature flag off: preserve legacy unlimited path exactly.
      return Promise.resolve(() => { /* noop */ });
    }

    const key = {
      host: normalizeHost(opts.host),
      company: normalizeCompany(opts.company),
      account: normalizeAccount(opts.account),
    };

    // Fast path: capacity available AND no one ahead of us in this class.
    const queue = opts.priority === "interactive" ? waitingInteractive : waitingBackground;
    if (queue.length === 0 && canAdmitKey(key)) {
      const w: Waiter = {
        id: nextWaiterId++,
        key,
        priority: opts.priority,
        enqueuedAtMs: Date.now(),
        resolve: () => {},
        reject: () => {},
        timer: null,
        onAbort: null,
        settled: true,
      };
      const release = admit(w);
      if (opts.priority === "interactive") interactiveStreak++;
      else interactiveStreak = 0;
      return Promise.resolve(release);
    }

    // Cancelled up-front — never enqueue.
    if (opts.signal?.aborted) {
      counters.cancelled++;
      return Promise.reject(new ImapBusyError("cancelled", 1));
    }

    // Backpressure: reject when combined wait queue is full.
    const totalWaiting = waitingInteractive.length + waitingBackground.length;
    if (totalWaiting >= cfg.waitQueueMax) {
      counters.rejectedQueueFull++;
      return Promise.reject(new ImapBusyError("queue-full", 5));
    }

    const timeoutMs = opts.waitTimeoutMs
      ?? (opts.priority === "interactive"
        ? cfg.interactiveWaitTimeoutMs
        : cfg.backgroundWaitTimeoutMs);

    return new Promise<ImapGateRelease>((resolve, reject) => {
      const waiter: Waiter = {
        id: nextWaiterId++,
        key,
        priority: opts.priority,
        enqueuedAtMs: Date.now(),
        resolve,
        reject,
        timer: null,
        onAbort: null,
        signal: opts.signal,
        settled: false,
      };

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        counters.timedOut++;
        settleWaiter(waiter);
        reject(new ImapBusyError("timeout", Math.max(1, Math.ceil(timeoutMs / 1000))));
      }, timeoutMs);
      // Timers are always cleared on settle (admit/timeout/abort), so they
      // never outlive the waiter — no unref needed and unref would break
      // node:test awaits on the timer's own reject path.

      if (opts.signal) {
        const onAbort = () => {
          if (waiter.settled) return;
          counters.cancelled++;
          settleWaiter(waiter);
          reject(new ImapBusyError("cancelled", 1));
        };
        waiter.onAbort = onAbort;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      queue.push(waiter);
      // In case capacity opened between fast-path check and enqueue.
      drain();
    });
  }

  function stats(): ImapGateStats {
    const byHost: Record<string, number> = {};
    for (const [k, v] of activeByHost) byHost[k] = v;
    return {
      enabled: cfg.enabled,
      activeGlobal,
      activeByHost: byHost,
      waitingInteractive: waitingInteractive.length,
      waitingBackground: waitingBackground.length,
      admitted: counters.admitted,
      rejected: counters.rejectedQueueFull,
      timedOut: counters.timedOut,
      cancelled: counters.cancelled,
      waitMsP50: percentile(50),
      waitMsP95: percentile(95),
      limits: {
        globalMax: cfg.globalMax,
        perHostMax: cfg.perHostMax,
        perCompanyMax: cfg.perCompanyMax,
        perAccountMax: cfg.perAccountMax,
        waitQueueMax: cfg.waitQueueMax,
        interactiveWaitTimeoutMs: cfg.interactiveWaitTimeoutMs,
        backgroundWaitTimeoutMs: cfg.backgroundWaitTimeoutMs,
      },
    };
  }

  function _reset(): void {
    // Test-only: drop counters + queues. Live acquires are unaffected.
    for (const w of waitingInteractive) settleWaiter(w);
    for (const w of waitingBackground) settleWaiter(w);
    waitingInteractive.length = 0;
    waitingBackground.length = 0;
    counters.admitted = 0;
    counters.rejectedQueueFull = 0;
    counters.timedOut = 0;
    counters.cancelled = 0;
    waitHistCount = 0;
    waitHistCursor = 0;
    interactiveStreak = 0;
  }

  return { acquire, stats, _reset };
}

/**
 * Build config from environment. Defaults are the conservative starting
 * values from the round brief. `IMAP_GATES_ENABLED` defaults to `false`.
 */
export function loadImapGatesConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImapGatesConfig {
  const num = (k: string, d: number): number => {
    const raw = env[k];
    if (raw == null || raw === "") return d;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const bool = (k: string, d: boolean): boolean => {
    const raw = (env[k] ?? "").toString().trim().toLowerCase();
    if (raw === "") return d;
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  };
  return {
    enabled: bool("IMAP_GATES_ENABLED", false),
    globalMax: num("IMAP_GLOBAL_MAX", 32),
    perHostMax: num("IMAP_PER_HOST_MAX", 12),
    perCompanyMax: num("IMAP_PER_COMPANY_MAX", 4),
    perAccountMax: num("IMAP_PER_ACCOUNT_MAX", 2),
    waitQueueMax: num("IMAP_WAIT_QUEUE_MAX", 200),
    interactiveWaitTimeoutMs: num("IMAP_INTERACTIVE_WAIT_TIMEOUT_MS", 8000),
    backgroundWaitTimeoutMs: num("IMAP_BACKGROUND_WAIT_TIMEOUT_MS", 30000),
  };
}
