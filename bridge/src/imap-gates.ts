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
 * `finally` block. `release` is idempotent. Waiters use five FIFO queues
 * (body / interactive / media / transfer / background).
 *
 * BODY is a RESERVED capacity class: explicit message-body opens (current
 * message + Previous Message expansion) are the highest priority class and
 * are exempt from the per-account non-body cap. The architecture keeps
 * IMAP_PER_ACCOUNT_MAX = 2 but enforces PER_ACCOUNT_NON_BODY_MAX = 1, so:
 *
 *   * BODY is never forced to wait behind media / transfer / background —
 *     one non-body op plus a BODY op run concurrently (total = 2).
 *   * Two non-body ops can never consume both account permits simultaneously
 *     (background + media, background + transfer, media + transfer all block
 *     at admission — enforced when the SECOND is admitted, never by killing
 *     an already-active operation).
 *   * Two BODY ops may both run (up to the account max of 2); a third
 *     operation waits. BODY may therefore serialize behind another BODY only
 *     when physical account capacity is already consumed by BODY work.
 *
 * Non-body classes (interactive / media / transfer / background) share the
 * single non-body slot with round-robin admission so no class starves; BODY
 * always outranks every non-body waiter. Overflow / timeout / cancellation
 * all fail fast with an `ImapBusyError` — callers translate that into
 * HTTP 503 + `IMAP_BUSY`.
 *
 * Feature-flagged behind `IMAP_GATES_ENABLED`. When disabled every
 * `acquire` resolves immediately with a no-op release — behaviour is
 * bit-identical to the previous unlimited path.
 *
 * Bounded, side-effect-free metrics are exposed via `stats()`.
 * No secrets, no email addresses, no account/company identifiers are
 * ever included in metrics or logs.
 */

export type ImapPriority = "body" | "interactive" | "media" | "transfer" | "background";

/** Priorities that are NOT message-body work and must not consume BODY capacity. */
const NON_BODY_PRIORITIES = new Set<ImapPriority>([
  "interactive",
  "media",
  "transfer",
  "background",
]);

export interface ImapGatesConfig {
  enabled: boolean;
  globalMax: number;
  perHostMax: number;
  perCompanyMax: number;
  perAccountMax: number;
  waitQueueMax: number;
  interactiveWaitTimeoutMs: number;
  backgroundWaitTimeoutMs: number;
  /**
   * Cap on concurrent MEDIA (CID/image) admissions per account. Kept strictly
   * below perAccountMax so media can never consume all of an account's
   * capacity and starve a body open. Optional for back-compat with
   * config literals; defaults to 1 when absent.
   */
  mediaPerAccountMax?: number;
  /** Optional; defaults to a value between interactive and background. */
  mediaWaitTimeoutMs?: number;
  /**
   * Max concurrent NON-BODY (interactive / media / transfer / background)
   * admissions per account. This is the reservation guarantee: at most one
   * non-body operation can run per account, so the other per-account slot is
   * always effectively reserved for explicit BODY work. Defaults to 1.
   */
  nonBodyPerAccountMax?: number;
  /** Optional; defaults to the same value as interactiveWaitTimeoutMs. */
  bodyWaitTimeoutMs?: number;
  /** Optional; defaults to a value between interactive and background. */
  transferWaitTimeoutMs?: number;
}

export function normalizeHost(host: string): string {
  return String(host || "")
    .trim()
    .toLowerCase();
}

export function normalizeAccount(email: string): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function normalizeCompany(id: string | undefined | null): string {
  const v = String(id ?? "")
    .trim()
    .toLowerCase();
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
  /** Number of distinct hosts with in-flight work. Host names are never
   * exposed here — this is a bounded count for capacity monitoring only. */
  activeHostCount: number;
  waitingBody: number;
  waitingInteractive: number;
  waitingMedia: number;
  waitingTransfer: number;
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
    mediaPerAccountMax: number;
    nonBodyPerAccountMax: number;
    waitQueueMax: number;
    interactiveWaitTimeoutMs: number;
    bodyWaitTimeoutMs: number;
    backgroundWaitTimeoutMs: number;
  };
}

export function createImapGates(cfg: ImapGatesConfig): ImapGates {
  const mediaPerAccountMax = Math.max(1, cfg.mediaPerAccountMax ?? 1);
  const nonBodyPerAccountMax = Math.max(1, cfg.nonBodyPerAccountMax ?? 1);
  const bodyWaitTimeoutMs = cfg.bodyWaitTimeoutMs ?? cfg.interactiveWaitTimeoutMs;
  const transferWaitTimeoutMs = cfg.transferWaitTimeoutMs ?? 15000;
  let activeGlobal = 0;
  const activeByHost = new Map<string, number>();
  const activeByCompany = new Map<string, number>();
  const activeByAccount = new Map<string, number>();
  const mediaByAccount = new Map<string, number>();
  const nonBodyByAccount = new Map<string, number>();

  const waitingBody: Waiter[] = [];
  const waitingInteractive: Waiter[] = [];
  const waitingMedia: Waiter[] = [];
  const waitingTransfer: Waiter[] = [];
  const waitingBackground: Waiter[] = [];

  // Round-robin cursor across the non-body classes so none starves forever
  // while sharing the single per-account non-body slot. BODY always outranks
  // every non-body waiter and is never part of this rotation.
  const NON_BODY_ORDER: ImapPriority[] = ["interactive", "media", "transfer", "background"];
  let nonBodyCursor = 0;

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

  /** MEDIA additionally caps how many of an account's permits it may hold. */
  function canAdmitMediaKey(key: { host: string; company: string; account: string }): boolean {
    return (mediaByAccount.get(key.account) ?? 0) < mediaPerAccountMax;
  }

  /**
   * A NON-BODY op may only use the single non-body slot. BODY is exempt — this
   * is the reservation: an account at 1 active non-body op still has one
   * permit free for explicit BODY work, but a second non-body op must wait.
   */
  function canAdmitNonBodyKey(key: { host: string; company: string; account: string }): boolean {
    return (nonBodyByAccount.get(key.account) ?? 0) < nonBodyPerAccountMax;
  }

  function isAdmissible(
    key: { host: string; company: string; account: string },
    priority: ImapPriority,
  ): boolean {
    if (!canAdmitKey(key)) return false;
    if (priority === "media" && !canAdmitMediaKey(key)) return false;
    if (NON_BODY_PRIORITIES.has(priority) && !canAdmitNonBodyKey(key)) return false;
    return true;
  }

  function admit(waiter: Waiter): ImapGateRelease {
    activeGlobal++;
    inc(activeByHost, waiter.key.host);
    inc(activeByCompany, waiter.key.company);
    inc(activeByAccount, waiter.key.account);
    if (waiter.priority === "media") inc(mediaByAccount, waiter.key.account);
    if (NON_BODY_PRIORITIES.has(waiter.priority)) {
      inc(nonBodyByAccount, waiter.key.account);
      nonBodyCursor = (nonBodyCursor + 1) % NON_BODY_ORDER.length;
    }
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
      if (waiter.priority === "media") dec(mediaByAccount, waiter.key.account);
      if (NON_BODY_PRIORITIES.has(waiter.priority)) dec(nonBodyByAccount, waiter.key.account);
      drain();
    };
    return release;
  }

  /** Pick the next waiter to admit, respecting per-key caps and reservation. */
  function pickNext(): Waiter | null {
    if (activeGlobal >= cfg.globalMax) return null;

    // BODY is the reserved, highest-priority class: any eligible body waiter
    // is admitted before every non-body class.
    const bodyEligible = firstEligible(waitingBody);
    if (bodyEligible) return bodyEligible;

    // No body waiting: round-robin the non-body classes so none starves.
    for (let i = 0; i < NON_BODY_ORDER.length; i++) {
      const cls = NON_BODY_ORDER[(nonBodyCursor + i) % NON_BODY_ORDER.length];
      const eligible = firstEligible(queueFor(cls));
      if (eligible) return eligible;
    }
    return null;
  }

  function queueFor(cls: ImapPriority): Waiter[] {
    switch (cls) {
      case "body":
        return waitingBody;
      case "interactive":
        return waitingInteractive;
      case "media":
        return waitingMedia;
      case "transfer":
        return waitingTransfer;
      default:
        return waitingBackground;
    }
  }

  function firstEligible(queue: Waiter[]): Waiter | null {
    for (let i = 0; i < queue.length; i++) {
      const w = queue[i];
      if (w.settled) continue;
      if (isAdmissible(w.key, w.priority)) return w;
    }
    return null;
  }

  function removeFromQueue(waiter: Waiter): void {
    const queue = queueFor(waiter.priority);
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
      try {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      } catch {
        /* noop */
      }
      waiter.onAbort = null;
    }
    removeFromQueue(waiter);
  }

  function drain(): void {
    // Loop: admit as many as possible respecting reservation + caps.
    // Bounded: pickNext returns null when no candidate can be admitted.
    let safety = 10_000;
    while (safety-- > 0) {
      const w = pickNext();
      if (!w) return;
      settleWaiter(w);
      const release = admit(w);
      w.resolve(release);
    }
  }

  function acquire(opts: AcquireOptions): Promise<ImapGateRelease> {
    if (!cfg.enabled) {
      // Feature flag off: preserve legacy unlimited path exactly.
      return Promise.resolve(() => {
        /* noop */
      });
    }

    const key = {
      host: normalizeHost(opts.host),
      company: normalizeCompany(opts.company),
      account: normalizeAccount(opts.account),
    };

    // Fast path: capacity available AND no one ahead of us in this class.
    const queue = queueFor(opts.priority);
    if (queue.length === 0 && isAdmissible(key, opts.priority)) {
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
      return Promise.resolve(release);
    }

    // Cancelled up-front — never enqueue.
    if (opts.signal?.aborted) {
      counters.cancelled++;
      return Promise.reject(new ImapBusyError("cancelled", 1));
    }

    // Backpressure: reject when combined wait queue is full. Every class
    // counts (body / interactive / media / transfer / background).
    const totalWaiting =
      waitingBody.length +
      waitingInteractive.length +
      waitingMedia.length +
      waitingTransfer.length +
      waitingBackground.length;
    if (totalWaiting >= cfg.waitQueueMax) {
      counters.rejectedQueueFull++;
      return Promise.reject(new ImapBusyError("queue-full", 5));
    }

    const timeoutMs =
      opts.waitTimeoutMs ??
      (opts.priority === "body"
        ? bodyWaitTimeoutMs
        : opts.priority === "interactive"
          ? cfg.interactiveWaitTimeoutMs
          : opts.priority === "media"
            ? (cfg.mediaWaitTimeoutMs ?? 15000)
            : opts.priority === "transfer"
              ? transferWaitTimeoutMs
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
    return {
      enabled: cfg.enabled,
      activeGlobal,
      activeHostCount: activeByHost.size,
      waitingBody: waitingBody.length,
      waitingInteractive: waitingInteractive.length,
      waitingMedia: waitingMedia.length,
      waitingTransfer: waitingTransfer.length,
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
        mediaPerAccountMax,
        nonBodyPerAccountMax,
        waitQueueMax: cfg.waitQueueMax,
        interactiveWaitTimeoutMs: cfg.interactiveWaitTimeoutMs,
        bodyWaitTimeoutMs,
        backgroundWaitTimeoutMs: cfg.backgroundWaitTimeoutMs,
      },
    };
  }

  function _reset(): void {
    // Test-only: drop counters + queues. Live acquires are unaffected.
    for (const w of waitingBody) settleWaiter(w);
    for (const w of waitingInteractive) settleWaiter(w);
    for (const w of waitingMedia) settleWaiter(w);
    for (const w of waitingTransfer) settleWaiter(w);
    for (const w of waitingBackground) settleWaiter(w);
    waitingBody.length = 0;
    waitingInteractive.length = 0;
    waitingMedia.length = 0;
    waitingTransfer.length = 0;
    waitingBackground.length = 0;
    counters.admitted = 0;
    counters.rejectedQueueFull = 0;
    counters.timedOut = 0;
    counters.cancelled = 0;
    waitHistCount = 0;
    waitHistCursor = 0;
    nonBodyCursor = 0;
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
    mediaPerAccountMax: num("IMAP_MEDIA_PER_ACCOUNT_MAX", 1),
    nonBodyPerAccountMax: num("IMAP_NON_BODY_PER_ACCOUNT_MAX", 1),
    mediaWaitTimeoutMs: num("IMAP_MEDIA_WAIT_TIMEOUT_MS", 15000),
    transferWaitTimeoutMs: num("IMAP_TRANSFER_WAIT_TIMEOUT_MS", 15000),
    waitQueueMax: num("IMAP_WAIT_QUEUE_MAX", 200),
    interactiveWaitTimeoutMs: num("IMAP_INTERACTIVE_WAIT_TIMEOUT_MS", 8000),
    bodyWaitTimeoutMs: num("IMAP_BODY_WAIT_TIMEOUT_MS", 8000),
    backgroundWaitTimeoutMs: num("IMAP_BACKGROUND_WAIT_TIMEOUT_MS", 30000),
  };
}
