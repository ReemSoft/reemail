// Background driver for Local Mail Index. Owns three flows for the currently
// open folder:
//   * initial  — bootstraps the index the first time the folder is opened
//                (only when the caller signals `indexed: false`).
//   * incremental — polled every `intervalMs` (default 45s) while the tab is
//                   visible; picks up new UIDs and flag deltas.
//   * reconcile — polled every `reconcileMs` (default 5 min) while visible,
//                 AFTER initial has succeeded, to tombstone messages that
//                 vanished from the server. Also callable imperatively via
//                 the returned `reconcileNow()` so a manual refresh can force
//                 one round.
//
// Guarantees:
//   * No overlap: at most one sync round in flight per (account, folder).
//     initial/incremental and reconcile share the same guard so they can
//     never race each other for the same folder.
//   * Pauses when the tab is hidden.
//   * Reconcile is a no-op until `indexed` becomes true, so tombstones are
//     only applied against a real, populated index.
//   * onSynced fires after every successful round so the caller can refetch
//     the current page from the index (tombstones then disappear from the
//     UI automatically).
import { useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { runMailSync, type RunMailSyncResult } from "@/lib/mail-sync.functions";
import type { MailSession } from "@/lib/mail-session";

const DEFAULT_INCREMENTAL_MS = 45_000;
const DEFAULT_RECONCILE_MS = 5 * 60_000;

export interface UseMailIndexSyncArgs {
  session: MailSession | null;
  /** IMAP path resolved by the caller (e.g. "INBOX", "[Gmail]/Sent Mail"). */
  folderPath: string | null;
  /** Canonical UI folder ("inbox", "sent", ...) — used for logs/analytics. */
  canonical: string | null;
  /** True when the caller already found rows for this folder in the index. */
  indexed: boolean;
  /** Fires after every successful sync round so the caller can refetch. */
  onSynced?: (result: Extract<RunMailSyncResult, { ok: true; busy: false }>) => void;
  /** Interval between incremental rounds. Defaults to 45s. */
  intervalMs?: number;
  /** Interval between reconcile rounds. Defaults to 5 minutes. */
  reconcileMs?: number;
  /** Master switch — pass false to disable the whole hook. */
  enabled?: boolean;
}

export interface UseMailIndexSyncHandle {
  /** Runs a reconcile round now (skips if a sync is already in flight or if
   *  the folder hasn't been index-bootstrapped yet). Safe to call from event
   *  handlers such as the header refresh button. */
  reconcileNow: () => Promise<void>;
  /** Runs an incremental round now, independent of the polling timer. */
  incrementalNow: () => Promise<void>;
}

type Mode = "initial" | "incremental" | "reconcile";

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

  const sync = useServerFn(runMailSync);
  // Refs so imperative calls always see the current args/session without
  // being invalidated across every render.
  const inflightRef = useRef<Promise<unknown> | null>(null);
  const didInitialRef = useRef<boolean>(indexed);
  const paramsRef = useRef({ session, folderPath, canonical, enabled });
  const onSyncedRef = useRef(onSynced);

  useEffect(() => {
    paramsRef.current = { session, folderPath, canonical, enabled };
  }, [session, folderPath, canonical, enabled]);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);
  useEffect(() => {
    didInitialRef.current = indexed;
  }, [indexed]);

  const runOnce = useCallback(
    async (mode: Mode): Promise<void> => {
      const p = paramsRef.current;
      if (!p.enabled) return;
      const token = p.session?.mailSessionToken;
      const password = p.session?.password;
      if (!token || !password || !p.folderPath || !p.canonical) return;
      // Reconcile is meaningless before the initial sync completed.
      if (mode === "reconcile" && !didInitialRef.current) return;
      if (inflightRef.current) return; // shared overlap guard

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
            onSyncedRef.current?.(res);
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

  // Polling loops — incremental and reconcile each own an independent timer,
  // but both share `inflightRef`, so they can never overlap with each other
  // or with an initial round.
  useEffect(() => {
    if (!enabled) return;
    const token = session?.mailSessionToken;
    if (!token || !session?.password || !folderPath || !canonical) return;

    let cancelled = false;
    let incrementalTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    // Reset per-folder initial flag when the caller says the folder isn't
    // indexed. Note: we intentionally don't reset when `indexed` is true —
    // that just means "already bootstrapped, no initial required".
    if (!indexed) didInitialRef.current = false;

    const isVisible = () => typeof document === "undefined" || !document.hidden;

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

    // Fire an immediate round to bootstrap or catch up quickly.
    void runOnce(didInitialRef.current ? "incremental" : "initial").then(() => {
      scheduleIncremental();
      scheduleReconcile();
    });

    return () => {
      cancelled = true;
      if (incrementalTimer) clearTimeout(incrementalTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  }, [session, folderPath, canonical, indexed, intervalMs, reconcileMs, enabled, runOnce]);

  const reconcileNow = useCallback(() => runOnce("reconcile"), [runOnce]);
  const incrementalNow = useCallback(
    () => runOnce(didInitialRef.current ? "incremental" : "initial"),
    [runOnce],
  );
  return { reconcileNow, incrementalNow };
}
