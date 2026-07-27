// SSOT for Mail Sync Queue tunables. Client-safe (pure constants only).
// Do NOT duplicate these values elsewhere. All queue code (RPCs, worker,
// tests) reads them from here.
//
// Rationale: the R1 audit demanded a single source of truth to avoid
// magical numbers scattered across migrations, RPCs, and workers.
//
// Values are conservative and intended for the initial rollout.
// See docs: MailMaestro-Scaling-Report.md for background.

export const MAIL_QUEUE_CONFIG = {
  /** Queue name in pgmq. */
  queueName: "mail_sync",
  /** Dead-letter queue name in pgmq. */
  deadQueueName: "mail_sync_dead",

  /** Max jobs claimed per Worker tick, globally. */
  claimBatchSize: 10,
  /** Max concurrent running jobs across all tenants. */
  globalConcurrency: 20,
  /** Max concurrent running jobs per company. */
  perCompanyConcurrency: 2,
  /** Max concurrent running jobs per account. Always 1 (protected by
   *  claim_mail_sync_lock at the folder level too). */
  perAccountConcurrency: 1,

  /** Visibility timeout (lease) applied on claim, in seconds. */
  leaseSeconds: 90,

  /** Retry backoff (exponential with jitter). */
  backoff: {
    baseSeconds: 30,
    capSeconds: 15 * 60,
    maxAttempts: 6,
    /** Jitter fraction of computed delay (0.0..1.0). */
    jitterFraction: 0.25,
  },

  /** Cleanup retention. */
  retention: {
    completedArchiveDays: 7,
    deadArchiveDays: 30,
  },

  /** Cron cadences. */
  cron: {
    /** How often the dispatcher runs. */
    tickIntervalSeconds: 60,
    /** How many Worker HTTP invocations per tick. */
    workersPerTick: 4,
  },

  /** Default cadences for scheduled syncs (seconds). */
  schedule: {
    incrementalDefault: 300, // 5 min
    reconcileDefault: 24 * 60 * 60, // daily
    priorityIncremental: 100,
    priorityReconcile: 500,
    priorityInitial: 10,
  },
} as const;

export type MailQueueKind = "initial" | "incremental" | "reconcile";

export const MAIL_QUEUE_KINDS: readonly MailQueueKind[] = [
  "initial",
  "incremental",
  "reconcile",
] as const;
