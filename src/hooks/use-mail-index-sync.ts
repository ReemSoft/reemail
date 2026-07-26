// Background poller for Local Mail Index sync. Runs incremental syncs on
// an interval while the tab is visible and a session token is present, with
// overlap guard so a slow round never stacks. Kicks off an initial sync if
// the caller signals the folder isn't indexed yet.
//
// Design goals:
//   * Never block the UI: everything runs in the background.
//   * Never overlap itself: one in-flight promise per (account, folder).
//   * Pause when the tab is hidden — mail apps do not need to churn IMAP
//     round-trips against a hidden tab.
//   * Cheap and cancellable so folder-switches don't leak intervals.
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { runMailSync, type RunMailSyncResult } from "@/lib/mail-sync.functions";
import type { MailSession } from "@/lib/mail-session";

const DEFAULT_INTERVAL_MS = 45_000;

export interface UseMailIndexSyncArgs {
  session: MailSession | null;
  /** IMAP path resolved by the caller (e.g. "INBOX"). */
  folderPath: string | null;
  /** Canonical UI folder ("inbox", "sent", ...). */
  canonical: string | null;
  /** True when the caller already found a row for this folder in the index. */
  indexed: boolean;
  /** Fires after every successful sync round so the caller can refetch. */
  onSynced?: (result: Extract<RunMailSyncResult, { ok: true; busy: false }>) => void;
  /** Interval between incremental rounds. Defaults to 45s. */
  intervalMs?: number;
  /** Master switch — pass false to disable the whole hook. */
  enabled?: boolean;
}

export function useMailIndexSync({
  session,
  folderPath,
  canonical,
  indexed,
  onSynced,
  intervalMs = DEFAULT_INTERVAL_MS,
  enabled = true,
}: UseMailIndexSyncArgs): void {
  const sync = useServerFn(runMailSync);
  const inflightRef = useRef<Promise<unknown> | null>(null);
  const cancelledRef = useRef(false);
  const onSyncedRef = useRef(onSynced);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled) return;
    const token = session?.mailSessionToken;
    const password = session?.password;
    if (!token || !password || !folderPath || !canonical) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let didInitial = indexed;

    async function runOnce(mode: "initial" | "incremental") {
      if (cancelledRef.current) return;
      if (inflightRef.current) return; // overlap guard
      const p = sync({
        data: {
          mailSessionToken: token!,
          password: password!,
          folderPath: folderPath!,
          canonical: canonical!,
          mode,
        },
      })
        .then((res) => {
          if (cancelledRef.current) return;
          if (res.ok && "busy" in res && res.busy === false) {
            if (mode === "initial") didInitial = true;
            onSyncedRef.current?.(res);
          }
        })
        .catch(() => {
          /* swallow — background best-effort */
        })
        .finally(() => {
          inflightRef.current = null;
        });
      inflightRef.current = p;
      await p;
    }

    function schedule() {
      if (cancelledRef.current) return;
      timer = setTimeout(async () => {
        if (typeof document !== "undefined" && document.hidden) {
          schedule();
          return;
        }
        await runOnce(didInitial ? "incremental" : "initial");
        schedule();
      }, intervalMs);
    }

    // Fire immediately once — either to bootstrap the index or to catch new mail.
    void runOnce(didInitial ? "incremental" : "initial").then(schedule);

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [session, folderPath, canonical, indexed, intervalMs, enabled, sync]);
}
