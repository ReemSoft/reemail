export interface PostSendFinalizerStats {
  active: number;
  queued: number;
  rejected: number;
}

interface FinalizerJob {
  key: string;
  run: () => Promise<void>;
}

export class PostSendFinalizerQueue {
  private readonly queue: FinalizerJob[] = [];
  private readonly activeByKey = new Map<string, number>();
  private active = 0;
  private rejected = 0;

  constructor(
    private readonly globalMax = 4,
    private readonly perKeyMax = 1,
    private readonly queueMax = 100,
  ) {}

  enqueue(key: string, run: () => Promise<void>): boolean {
    if (this.queue.length >= this.queueMax) {
      this.rejected++;
      return false;
    }
    this.queue.push({ key, run });
    this.drain();
    return true;
  }

  stats(): PostSendFinalizerStats {
    return { active: this.active, queued: this.queue.length, rejected: this.rejected };
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
      void Promise.resolve()
        .then(job.run)
        .catch(() => undefined)
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
