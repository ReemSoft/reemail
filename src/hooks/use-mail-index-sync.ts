// Background driver for Local Mail Index.
//
// Post-UX-fixes contract:
//   * `runOnce(mode, {suppressOnSynced})` — imperative runs can suppress the
//     onSynced broadcast so a manual Refresh can coalesce a single UI update
//     at the end instead of one after every sync round.
//   * onSynced only fires when the sync round actually changed something
//     (initial | wipedForUidValidity | wroteMessages | appliedFlagChanges |
//     tombstoned). A zero-delta incremental never redraws the UI.
//   * The polling effect no longer restarts when `indexed` flips false→true
//     (that transition previously caused an extra immediate incremental
//     right after the initial). The effect depends only on the stable loop
//     key; `indexed` is tracked in a ref.
//   * shouldReconcile() lets callers ask whether a reconcile is due:
//     `flagsNeedReconcile` is true, OR the last reconcile is older than
//     `reconcileMs`, OR no reconcile has ever run.
import { useCallback, useEffect, useRef } from "react";
import { runMailSync, type RunMailSyncResult } from "@/lib/mail-sync.functions";
import type { MailSession } from "@/lib/mail-session";
import { useMailServerFn } from "@/hooks/use-mail-session-renewal";

const DEFAULT_INCREMENTAL_MS = 45_000;
const DEFAULT_RECONCILE_MS = 5 * 60_000;

type SuccessResult = Extract<RunMailSyncResult, { ok: true; busy: false }>;

export interface UseMailIndexSyncArgs {
  session: MailSession | null;
  folderPath: string | null;
  canonical: string | null;
  indexed: boolean;
  onSynced?: (result: SuccessResult) => void;
  intervalMs?: number;
  reconcileMs?: number;
  enabled?: boolean;
}

export interface RunOpts {
  suppressOnSynced?: boolean;
}

export interface UseMailIndexSyncHandle {
  reconcileNow: (opts?: RunOpts) => Promise<void>;
  incrementalNow: (opts?: RunOpts) => Promise<void>;
  /** Reconcile is due (flags drift OR interval elapsed). Requires an initial. */
  shouldReconcile: () => boolean;
}

type Mode = "initial" | "incremental" | "reconcile";

export function hasMeaningfulChange(res: SuccessResult): boolean {
  return (
    res.mode === "initial" ||
    res.wipedForUidValidity ||
    res.wroteMessages > 0 ||
    res.appliedFlagChanges > 0 ||
    res.tombstoned > 0
  );
}

export function useMailIndexSync(args: UseMailIndexSyncArgs): UseMailIndexSyncHandle {
  const {
    session,
    folderPath,
    canonical,
    indexed,
    onSynced,
    intervalMs = DEFAULT_INCREMENTAL_MS,
    reconcileMs = DEFAULT_RECONCILE_MS,
    enabled = true,
  } = args;

  const sync = useMailServerFn(runMailSync);

  const inflightRef = useRef<Promise<unknown> | null>(null);
  const didInitialRef = useRef<boolean>(indexed);
  const flagsNeedReconcileRef = useRef<boolean>(false);
  const lastReconcileAtRef = useRef<number>(0);
  const paramsRef = useRef({ session, folderPath, canonical, enabled });
  const onSyncedRef = useRef(onSynced);
  const indexedRef = useRef(indexed);
  const bootstrappedKeyRef = useRef<string>("");

  useEffect(() => {
    paramsRef.current = { session, folderPath, canonical, enabled };
  }, [session, folderPath, canonical, enabled]);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);
  useEffect(() => {
    indexedRef.current = indexed;
    if (indexed) didInitialRef.current = true;
  }, [indexed]);

  const runOnce = useCallback(
    async (mode: Mode, opts?: RunOpts): Promise<void> => {
      const p = paramsRef.current;
      if (!p.enabled) return;
      const token = p.session?.mailSessionToken;
      const password = p.session?.password;
      if (!token || !password || !p.folderPath || !p.canonical) return;
      if (mode === "reconcile" && !didInitialRef.current) return;
      if (inflightRef.current) return;

      const call = sync({
        data: {
          mailSessionToken: token,
          password,
          folderPath: p.folderPath,
          canonical: p.canonical,
          mode,
        },
      })
        .then((res) => {
          if (res.ok && "busy" in res && res.busy === false) {
            if (mode === "initial") didInitialRef.current = true;
            if (mode === "reconcile") {
              lastReconcileAtRef.current = Date.now();
              flagsNeedReconcileRef.current = false;
            }
            if (res.flagsSync === "reconcile-required") {
              flagsNeedReconcileRef.current = true;
            }
            const notify = !opts?.suppressOnSynced && hasMeaningfulChange(res);
            if (notify) onSyncedRef.current?.(res);
          }
        })
        .catch(() => {
          /* swallow — background best-effort */
        })
        .finally(() => {
          inflightRef.current = null;
        });
      inflightRef.current = call;
      await call;
    },
    [sync],
  );

  // Stable loop key. Deliberately excludes `indexed` — flipping indexed after
  // an initial must NOT restart the effect (which would trigger an extra
  // immediate incremental right after the bootstrap round).
  const loopKey = `${session?.mailSessionToken || ""}|${folderPath || ""}|${canonical || ""}|${enabled ? "1" : "0"}|${intervalMs}|${reconcileMs}`;

  useEffect(() => {
    if (!enabled) return;
    const token = session?.mailSessionToken;
    if (!token || !session?.password || !folderPath || !canonical) return;

    let cancelled = false;
    let incrementalTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

    const isVisible = () => typeof document === "undefined" || !document.hidden;

    const bootstrapKey = `${token}|${folderPath}|${canonical}`;
    const isFirstBootstrap = bootstrappedKeyRef.current !== bootstrapKey;
    if (isFirstBootstrap) {
      bootstrappedKeyRef.current = bootstrapKey;
      didInitialRef.current = indexedRef.current;
      flagsNeedReconcileRef.current = false;
      lastReconcileAtRef.current = 0;
    }

    function scheduleIncremental() {
      if (cancelled) return;
      incrementalTimer = setTimeout(async () => {
        if (!isVisible()) {
          scheduleIncremental();
          return;
        }
        await runOnce(didInitialRef.current ? "incremental" : "initial");
        scheduleIncremental();
      }, intervalMs);
    }

    function scheduleReconcile() {
      if (cancelled) return;
      reconcileTimer = setTimeout(async () => {
        if (!isVisible() || !didInitialRef.current) {
          scheduleReconcile();
          return;
        }
        await runOnce("reconcile");
        scheduleReconcile();
      }, reconcileMs);
    }

    if (isFirstBootstrap) {
      // First mount on this key — bootstrap with an immediate round.
      void runOnce(didInitialRef.current ? "incremental" : "initial").then(() => {
        scheduleIncremental();
        scheduleReconcile();
      });
    } else {
      // Rerun caused only by the loop-key ping (session/folder/etc unchanged).
      // Do NOT fire an immediate incremental — just re-arm timers.
      scheduleIncremental();
      scheduleReconcile();
    }

    return () => {
      cancelled = true;
      if (incrementalTimer) clearTimeout(incrementalTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopKey]);

  const reconcileNow = useCallback((opts?: RunOpts) => runOnce("reconcile", opts), [runOnce]);
  const incrementalNow = useCallback(
    (opts?: RunOpts) => runOnce(didInitialRef.current ? "incremental" : "initial", opts),
    [runOnce],
  );
  const shouldReconcile = useCallback(() => {
    if (!didInitialRef.current) return false;
    if (flagsNeedReconcileRef.current) return true;
    if (lastReconcileAtRef.current === 0) return true;
    return Date.now() - lastReconcileAtRef.current >= reconcileMs;
  }, [reconcileMs]);

  return { reconcileNow, incrementalNow, shouldReconcile };
}
