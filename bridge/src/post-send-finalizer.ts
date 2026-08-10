import { randomBytes } from "node:crypto";

export type SentCopyState = "pending" | "saved" | "failed" | "rejected";
export type SentCopySource = "provider" | "append";

export interface SentCopyOutcome {
  state: "saved" | "failed";
  source?: SentCopySource;
  code?: string;
}

export interface SentCopyJobStatus {
  jobId: string;
  state: SentCopyState;
  source?: SentCopySource;
  code?: string;
}

export interface SentCopyEnqueueResult extends SentCopyJobStatus {
  accepted: boolean;
}

export interface PostSendFinalizerStats {
  active: number;
  queued: number;
  rejected: number;
  tracked: number;
}

interface TrackedJob extends SentCopyJobStatus {
  key: string;
  createdAt: number;
  expiresAt: number;
}

interface FinalizerJob {
  key: string;
  jobId?: string;
  run: () => Promise<SentCopyOutcome | void>;
}

export class PostSendFinalizerQueue {
  private readonly queue: FinalizerJob[] = [];
  private readonly activeByKey = new Map<string, number>();
  private readonly tracked = new Map<string, TrackedJob>();
  private active = 0;
  private rejected = 0;

  constructor(
    private readonly globalMax = 4,
    private readonly perKeyMax = 1,
    private readonly queueMax = 100,
    private readonly trackerMax = 256,
    private readonly statusTtlMs = 2 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Legacy untracked enqueue retained for non-status callers and tests. */
  enqueue(key: string, run: () => Promise<void>): boolean {
    if (this.queue.length >= this.queueMax) {
      this.rejected++;
      return false;
    }
    this.queue.push({ key, run });
    this.drain();
    return true;
  }

  enqueueTracked(key: string, run: () => Promise<SentCopyOutcome>): SentCopyEnqueueResult {
    this.cleanupExpired();
    const jobId = randomBytes(24).toString("base64url");
    if (this.queue.length >= this.queueMax || !this.reserveTrackerSlot()) {
      this.rejected++;
      const rejected: SentCopyEnqueueResult = {
        accepted: false,
        jobId,
        state: "rejected",
        code: "QUEUE_FULL",
      };
      if (this.tracked.size < this.trackerMax) this.track(key, rejected);
      return rejected;
    }
    const pending: SentCopyEnqueueResult = { accepted: true, jobId, state: "pending" };
    this.track(key, pending);
    this.queue.push({ key, jobId, run });
    this.drain();
    return pending;
  }

  getStatus(key: string, jobId: string): SentCopyJobStatus | undefined {
    this.cleanupExpired();
    const job = this.tracked.get(jobId);
    if (!job || job.key !== key) return undefined;
    return {
      jobId: job.jobId,
      state: job.state,
      ...(job.source ? { source: job.source } : {}),
      ...(job.code ? { code: job.code } : {}),
    };
  }

  stats(): PostSendFinalizerStats {
    this.cleanupExpired();
    return {
      active: this.active,
      queued: this.queue.length,
      rejected: this.rejected,
      tracked: this.tracked.size,
    };
  }

  private track(key: string, status: SentCopyJobStatus): void {
    const createdAt = this.now();
    this.tracked.set(status.jobId, {
      ...status,
      key,
      createdAt,
      expiresAt: createdAt + this.statusTtlMs,
    });
  }

  private complete(jobId: string, outcome: SentCopyOutcome): void {
    const job = this.tracked.get(jobId);
    if (!job) return;
    job.state = outcome.state;
    job.source = outcome.source;
    job.code = outcome.code;
    job.expiresAt = this.now() + this.statusTtlMs;
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [jobId, job] of this.tracked) {
      if (job.expiresAt <= now && job.state !== "pending") this.tracked.delete(jobId);
    }
  }

  private reserveTrackerSlot(): boolean {
    if (this.tracked.size < this.trackerMax) return true;
    let oldest: TrackedJob | undefined;
    for (const job of this.tracked.values()) {
      if (job.state === "pending") continue;
      if (!oldest || job.createdAt < oldest.createdAt) oldest = job;
    }
    if (!oldest) return false;
    this.tracked.delete(oldest.jobId);
    return true;
  }

  private drain(): void {
    while (this.active < this.globalMax) {
      const index = this.queue.findIndex(
        ({ key }) => (this.activeByKey.get(key) ?? 0) < this.perKeyMax,
      );
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      this.active++;
      this.activeByKey.set(job.key, (this.activeByKey.get(job.key) ?? 0) + 1);
      const startedAt = this.now();
      void Promise.resolve()
        .then(job.run)
        .then((outcome) => {
          if (!job.jobId || !outcome) return;
          this.complete(job.jobId, outcome);
          console.info("[bridge] sent-copy completed", {
            state: outcome.state,
            durationMs: Math.max(0, this.now() - startedAt),
            ...(outcome.source ? { source: outcome.source } : {}),
            ...(outcome.code ? { code: outcome.code } : {}),
          });
        })
        .catch(() => {
          if (job.jobId) this.complete(job.jobId, { state: "failed", code: "FINALIZER_FAILED" });
          console.warn("[bridge] sent-copy completed", {
            state: "failed",
            code: "FINALIZER_FAILED",
            durationMs: Math.max(0, this.now() - startedAt),
          });
        })
        .finally(() => {
          this.active--;
          const remaining = (this.activeByKey.get(job.key) ?? 1) - 1;
          if (remaining === 0) this.activeByKey.delete(job.key);
          else this.activeByKey.set(job.key, remaining);
          this.drain();
        });
    }
  }
}

export const postSendFinalizers = new PostSendFinalizerQueue();
