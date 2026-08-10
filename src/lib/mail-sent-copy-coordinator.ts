export type SentCopyState = "pending" | "saved" | "failed" | "rejected";

export interface SentCopyStatus {
  ok: boolean;
  state?: SentCopyState;
  code?: string;
  error?: string;
}

export type SentCopyWatchResult = "saved" | "failed" | "unknown" | "aborted";
export type SentSyncOutcome = "synced" | "missing-path" | "busy" | "failed" | "aborted";

export const SENT_BUSY_SHORT_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
export const SENT_BUSY_DEFERRED_DELAY_MS = 3_000;

export async function watchSentCopy(params: {
  check: () => Promise<SentCopyStatus>;
  signal: AbortSignal;
  delays?: readonly number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<SentCopyWatchResult> {
  const delays = params.delays ?? [250, 500, 1_000, 2_000, 4_000];
  const sleep = params.sleep ?? abortableSleep;
  for (const delay of delays) {
    if (params.signal.aborted) return "aborted";
    try {
      await sleep(delay, params.signal);
    } catch {
      return "aborted";
    }
    let status: SentCopyStatus;
    try {
      status = await params.check();
    } catch {
      status = { ok: false };
    }
    if (params.signal.aborted) return "aborted";
    if (status.ok && status.state === "saved") return "saved";
    if (status.ok && (status.state === "failed" || status.state === "rejected")) return "failed";
    if (!status.ok && (status.code === "STATUS_NOT_FOUND" || status.error === "STATUS_NOT_FOUND"))
      return "unknown";
  }
  return "unknown";
}

export async function coordinateSentCopyCompletion(params: {
  state?: SentCopyState;
  pending: boolean;
  hasJob: boolean;
  watch: () => Promise<SentCopyWatchResult>;
  requestSync: () => void | Promise<void>;
  warnCopyFailure: () => void;
}): Promise<void> {
  if (params.state === "saved") {
    await params.requestSync();
    return;
  }
  if (params.pending && params.hasJob) {
    const outcome = await params.watch();
    if (outcome === "aborted") return;
    if (outcome === "failed") params.warnCopyFailure();
    await params.requestSync();
    return;
  }
  params.warnCopyFailure();
  await params.requestSync();
}

export function createSentSyncCoalescer(
  runSync: (signal: AbortSignal) => Promise<SentSyncOutcome>,
  options: {
    deferredBusyDelayMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    onPersistentBusy?: () => void;
  } = {},
) {
  let current: Promise<void> | null = null;
  let trailing = false;
  let disposed = false;
  const controller = new AbortController();
  const deferredBusyDelayMs = options.deferredBusyDelayMs ?? SENT_BUSY_DEFERRED_DELAY_MS;
  const sleep = options.sleep ?? abortableSleep;

  return {
    request(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (current) {
        trailing = true;
        return current;
      }
      current = (async () => {
        let deferredBusyUsed = false;
        do {
          trailing = false;
          const outcome = await runSync(controller.signal);
          if (disposed) return;
          if (outcome === "aborted") return;
          if (outcome === "busy") {
            if (deferredBusyUsed) {
              options.onPersistentBusy?.();
              return;
            }
            deferredBusyUsed = true;
            try {
              await sleep(deferredBusyDelayMs, controller.signal);
            } catch {
              return;
            }
            if (disposed) return;
            trailing = true;
          }
        } while (trailing && !disposed);
      })().finally(() => {
        current = null;
        trailing = false;
      });
      return current;
    },
    isRunning(): boolean {
      return current !== null;
    },
    dispose(): void {
      disposed = true;
      trailing = false;
      controller.abort();
    },
  };
}

type SyncResult = { ok: true; busy: boolean } | { ok: false; code: string };

export async function runTargetedSentSync(params: {
  signal: AbortSignal;
  sentPath?: string;
  sync: (mode: "incremental" | "initial", folderPath: string) => Promise<SyncResult>;
  refreshCounts: () => Promise<void>;
  currentFolder: () => string;
  refreshSentList: () => Promise<void>;
  busyRetryDelays?: readonly number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<SentSyncOutcome> {
  if (params.signal.aborted) return "aborted";
  if (!params.sentPath) return "missing-path";
  const busyRetryDelays = params.busyRetryDelays ?? SENT_BUSY_SHORT_RETRY_DELAYS_MS;
  const sleep = params.sleep ?? abortableSleep;
  let result: SyncResult;
  for (let attempt = 0; ; attempt++) {
    if (params.signal.aborted) return "aborted";
    result = await params.sync("incremental", params.sentPath);
    if (params.signal.aborted) return "aborted";
    if (!result.ok || !result.busy || attempt >= busyRetryDelays.length) break;
    try {
      await sleep(busyRetryDelays[attempt], params.signal);
    } catch {
      return "aborted";
    }
    if (params.signal.aborted) return "aborted";
  }
  if (!result.ok && result.code === "NO_CURSOR") {
    if (params.signal.aborted) return "aborted";
    result = await params.sync("initial", params.sentPath);
    if (params.signal.aborted) return "aborted";
  }
  if (!result.ok) return "failed";
  if (result.busy) return "busy";
  if (params.signal.aborted) return "aborted";
  await params.refreshCounts();
  if (params.signal.aborted) return "aborted";
  if (params.currentFolder() === "sent") {
    if (params.signal.aborted) return "aborted";
    await params.refreshSentList();
    if (params.signal.aborted) return "aborted";
  }
  return "synced";
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new Error("ABORTED"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
