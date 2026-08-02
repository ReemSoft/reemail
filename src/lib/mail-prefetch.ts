export type PrefetchPriority = "adjacent" | "visible" | "hover";

const PRIORITY: Record<PrefetchPriority, number> = {
  adjacent: 0,
  hover: 1,
  visible: 2,
};

interface QueuedTask<T> {
  key: string;
  priority: number;
  sequence: number;
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T | undefined) => void;
  promise: Promise<T | undefined>;
}

export class AdaptivePrefetchQueue<T> {
  private queue: QueuedTask<T>[] = [];
  private promises = new Map<string, Promise<T | undefined>>();
  private running = false;
  private runningController: AbortController | null = null;
  private runningItem: QueuedTask<T> | null = null;
  private sequence = 0;
  private generation = 0;

  enqueue(
    key: string,
    priority: PrefetchPriority,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const existing = this.promises.get(key);
    if (existing) {
      const queued = this.queue.find((item) => item.key === key);
      if (queued) queued.priority = Math.min(queued.priority, PRIORITY[priority]);
      this.sort();
      return existing;
    }
    const generation = this.generation;
    let resolve!: (value: T | undefined) => void;
    const promise = new Promise<T | undefined>((done) => {
      resolve = done;
    });
    this.promises.set(key, promise);
    this.queue.push({
      key,
      priority: PRIORITY[priority],
      sequence: this.sequence++,
      task,
      resolve,
      promise,
    });
    this.sort();
    void this.drain(generation);
    return promise;
  }

  cancelAll(options: { abortRunning?: boolean } = {}): void {
    this.generation++;
    if (options.abortRunning !== false) {
      this.runningController?.abort();
      const runningItem = this.runningItem;
      if (runningItem && this.promises.get(runningItem.key) === runningItem.promise) {
        this.promises.delete(runningItem.key);
      }
    }
    for (const item of this.queue) {
      item.resolve(undefined);
      this.promises.delete(item.key);
    }
    this.queue = [];
  }

  cancel(key: string): boolean {
    const index = this.queue.findIndex((item) => item.key === key);
    if (index < 0) return false;
    const [item] = this.queue.splice(index, 1);
    this.promises.delete(key);
    item.resolve(undefined);
    return true;
  }

  pendingKeys(): string[] {
    return this.queue.map((item) => item.key);
  }

  isRunning(): boolean {
    return this.running;
  }

  private sort(): void {
    this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  }

  private async drain(generation: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const item = this.queue.shift()!;
        this.runningItem = item;
        const controller = new AbortController();
        this.runningController = controller;
        let result: T | undefined;
        try {
          result = await item.task(controller.signal);
        } catch {
          result = undefined;
        } finally {
          if (this.runningController === controller) this.runningController = null;
          if (this.runningItem === item) this.runningItem = null;
        }
        if (this.promises.get(item.key) === item.promise) this.promises.delete(item.key);
        item.resolve(generation === this.generation ? result : undefined);
      }
    } finally {
      this.running = false;
      this.runningController = null;
      this.runningItem = null;
      if (this.queue.length > 0) void this.drain(this.generation);
    }
  }
}

export function firstVisiblePrefetchIds(ids: string[], limit = 5): string[] {
  return ids.slice(0, Math.max(0, limit));
}

export function adjacentPrefetchIds(ids: string[], selectedId: string, radius = 2): string[] {
  const index = ids.indexOf(selectedId);
  if (index < 0) return [];
  const out: string[] = [];
  for (let distance = 1; distance <= radius; distance++) {
    if (index - distance >= 0) out.push(ids[index - distance]);
    if (index + distance < ids.length) out.push(ids[index + distance]);
  }
  return out;
}

export function shouldUseWidePrefetch(
  connection?: {
    saveData?: boolean;
    effectiveType?: string;
  } | null,
): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}

export function cancelScheduledPrefetch(
  timers: Map<string, number>,
  cancelIdle: (() => void) | null,
  clearTimer: (timer: number) => void = (timer) => globalThis.clearTimeout(timer),
): void {
  for (const timer of timers.values()) clearTimer(timer);
  timers.clear();
  cancelIdle?.();
}

export function abortInflightControllers<T extends { controller: AbortController }>(
  entries: Map<string, T>,
): void {
  for (const entry of entries.values()) entry.controller.abort();
  entries.clear();
}
