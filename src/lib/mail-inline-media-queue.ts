/**
 * Browser-side, per-account scheduler for visible-message CID/media work.
 *
 * Bridge admits one non-body/media operation per account. This scheduler
 * mirrors that bound in the browser, but gives newly-visible small images
 * precedence over deferred image batches. A deferred attempt is abortable and
 * may be resumed after the visible job; message/body opening never imports or
 * uses this helper.
 */
export type InlineMediaPriority = "visible" | "deferred";

const MAX_DEFERRED_PREEMPTIONS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

interface InlineMediaJob<T> {
  id: number;
  priority: InlineMediaPriority;
  signal: AbortSignal;
  task: (attemptSignal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  attemptController: AbortController | null;
  preemptRequested: boolean;
  preemptions: number;
  settled: boolean;
  onAbort: () => void;
}

interface AccountQueue {
  active: InlineMediaJob<unknown> | null;
  waiting: InlineMediaJob<unknown>[];
}

const queues = new Map<string, AccountQueue>();
let nextJobId = 1;

function abortError(): Error {
  const error = new Error("INLINE_MEDIA_ABORTED");
  error.name = "AbortError";
  return error;
}

function queueFor(accountId: string): AccountQueue {
  let queue = queues.get(accountId);
  if (!queue) {
    queue = { active: null, waiting: [] };
    queues.set(accountId, queue);
  }
  return queue;
}

function cleanupAccount(accountId: string, queue: AccountQueue): void {
  if (!queue.active && queue.waiting.length === 0 && queues.get(accountId) === queue) {
    queues.delete(accountId);
  }
}

function settleJob<T>(job: InlineMediaJob<T>, outcome: { value: T } | { error: unknown }): void {
  if (job.settled) return;
  job.settled = true;
  job.signal.removeEventListener("abort", job.onAbort);
  if ("value" in outcome) job.resolve(outcome.value);
  else job.reject(outcome.error);
}

function nextWaiting(queue: AccountQueue): InlineMediaJob<unknown> | null {
  const visibleIndex = queue.waiting.findIndex(
    (job) => !job.settled && job.priority === "visible" && !job.signal.aborted,
  );
  const index = visibleIndex >= 0 ? visibleIndex : queue.waiting.findIndex((job) => !job.settled);
  if (index < 0) return null;
  return queue.waiting.splice(index, 1)[0];
}

function pump(accountId: string, queue: AccountQueue): void {
  if (queue.active) return;
  const job = nextWaiting(queue);
  if (!job) {
    queue.waiting = queue.waiting.filter((candidate) => !candidate.settled);
    cleanupAccount(accountId, queue);
    return;
  }
  if (job.signal.aborted) {
    settleJob(job, { error: abortError() });
    pump(accountId, queue);
    return;
  }

  queue.active = job;
  job.preemptRequested = false;
  const attemptController = new AbortController();
  job.attemptController = attemptController;

  void job
    .task(attemptController.signal)
    .then(
      (value) => {
        if (job.signal.aborted) {
          settleJob(job, { error: abortError() });
        } else if (job.preemptRequested) {
          job.attemptController = null;
          queue.waiting.push(job);
        } else {
          settleJob(job, { value });
        }
      },
      (error) => {
        if (job.signal.aborted) {
          settleJob(job, { error: abortError() });
        } else if (job.preemptRequested) {
          job.attemptController = null;
          queue.waiting.push(job);
        } else {
          settleJob(job, { error });
        }
      },
    )
    .finally(() => {
      if (queue.active === job) queue.active = null;
      job.attemptController = null;
      pump(accountId, queue);
    });
}

export function runInlineMediaQueued<T>(
  accountId: string,
  signal: AbortSignal,
  priority: InlineMediaPriority,
  task: (attemptSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const key = accountId.trim();
  if (!key) return Promise.reject(new Error("INLINE_MEDIA_ACCOUNT_REQUIRED"));
  if (signal.aborted) return Promise.reject(abortError());

  const queue = queueFor(key);
  return new Promise<T>((resolve, reject) => {
    const job: InlineMediaJob<T> = {
      id: nextJobId++,
      priority,
      signal,
      task,
      resolve,
      reject,
      attemptController: null,
      preemptRequested: false,
      preemptions: 0,
      settled: false,
      onAbort: () => {
        if (job.settled) return;
        job.attemptController?.abort();
        if (queue.active !== job) {
          queue.waiting = queue.waiting.filter((candidate) => candidate !== job);
          settleJob(job, { error: abortError() });
          cleanupAccount(key, queue);
        }
      },
    };
    signal.addEventListener("abort", job.onAbort, { once: true });
    queue.waiting.push(job as InlineMediaJob<unknown>);

    const active = queue.active;
    if (
      priority === "visible" &&
      active?.priority === "deferred" &&
      !active.preemptRequested &&
      active.preemptions < MAX_DEFERRED_PREEMPTIONS
    ) {
      active.preemptions += 1;
      active.preemptRequested = true;
      active.attemptController?.abort();
    }
    pump(key, queue);
  });
}

export interface InlineMediaRetryOptions {
  maxRetries?: number;
  delayMs?: number;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry only results/errors explicitly classified as transient, with a hard cap. */
export async function runInlineMediaWithBoundedRetry<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
  isTransient: (outcome: { result?: T; error?: unknown }) => boolean | number,
  options: InlineMediaRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 1));
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_RETRY_DELAY_MS);
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw abortError();
    let retryDelayMs = delayMs * (attempt + 1);
    try {
      const result = await task();
      const transient = isTransient({ result });
      if (attempt >= maxRetries || transient === false) return result;
      if (typeof transient === "number") retryDelayMs = transient;
    } catch (error) {
      const transient = isTransient({ error });
      if (signal.aborted || attempt >= maxRetries || transient === false) throw error;
      if (typeof transient === "number") retryDelayMs = transient;
    }
    await abortableDelay(Math.max(0, Math.min(2_000, retryDelayMs)), signal);
  }
}

export function inlineMediaQueueSizeForTests(): number {
  return queues.size;
}

export function resetInlineMediaQueueForTests(): void {
  for (const queue of queues.values()) {
    queue.active?.attemptController?.abort();
    for (const job of queue.waiting) settleJob(job, { error: abortError() });
  }
  queues.clear();
  nextJobId = 1;
}
