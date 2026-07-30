// Silent Mail Session renewal — React wiring.
//
//  * `useMailSessionRenewal()` installs the renewer (proactive timer + a check
//    whenever the tab becomes visible again). Mount it once in the mail app.
//  * `useMailServerFn(fn)` is a drop-in replacement for `useServerFn(fn)` that
//    transparently renews an expired session and retries the call once.
import { useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getMailSession, updateMailSessionToken } from "@/lib/mail-session";
import { renewMailSession } from "@/lib/mail-session-renew.functions";
import {
  callWithSessionRetry,
  createSingleFlightRenewer,
  type Renewer,
} from "@/lib/mail-session-retry";

/** Renew this many seconds before the token actually expires. */
const PROACTIVE_WINDOW_SECONDS = 10 * 60;
const CHECK_INTERVAL_MS = 60_000;

let renewImpl: Renewer = async () => null;
let onExpiredHandler: (() => void) | null = null;

/** Single-flight: concurrent failures share one renewal round-trip. */
export const renewMailSessionNow: Renewer = createSingleFlightRenewer(() => renewImpl());

export function useMailSessionRenewal(opts?: { onExpired?: () => void }) {
  const renewFn = useServerFn(renewMailSession);
  const onExpiredRef = useRef(opts?.onExpired);
  onExpiredRef.current = opts?.onExpired;

  useEffect(() => {
    renewImpl = async () => {
      const s = getMailSession();
      if (!s?.mailSessionToken || !s.password) return null;
      try {
        const res = await renewFn({
          data: { mailSessionToken: s.mailSessionToken, password: s.password },
        });
        if (!res.ok) return null;
        updateMailSessionToken(res.mailSessionToken, res.mailSessionTokenExpiresAt);
        return res.mailSessionToken;
      } catch {
        return null;
      }
    };
    onExpiredHandler = () => onExpiredRef.current?.();

    const maybeRenew = () => {
      const s = getMailSession();
      const exp = s?.mailSessionTokenExpiresAt;
      if (!s?.mailSessionToken || !exp) return;
      const secondsLeft = exp - Math.floor(Date.now() / 1000);
      if (secondsLeft <= PROACTIVE_WINDOW_SECONDS) void renewMailSessionNow();
    };

    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      maybeRenew();
    }, CHECK_INTERVAL_MS);

    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) maybeRenew();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    maybeRenew();

    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
      renewImpl = async () => null;
      onExpiredHandler = null;
    };
  }, [renewFn]);
}

/** `useServerFn` + silent session renewal & single retry. */
export function useMailServerFn<F extends (arg: never) => Promise<unknown>>(fn: F): F {
  const call = useServerFn(fn as never) as unknown as (arg: unknown) => Promise<unknown>;
  return useCallback(
    (arg: unknown) =>
      callWithSessionRetry(call, arg, {
        renew: renewMailSessionNow,
        onRenewFailed: () => onExpiredHandler?.(),
      }),
    [call],
  ) as unknown as F;
}
