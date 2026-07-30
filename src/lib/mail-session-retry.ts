// Session-expiry detection + single-flight silent renewal (pure, testable).
//
// Every mail server function authenticates with the short-lived Mail Session
// Token. When it expires the function returns `{ ok:false, code:"INVALID_TOKEN" }`
// (or throws with that code). Instead of surfacing a misleading "connection
// failed" banner, the UI silently renews the token using the password already
// held in sessionStorage and retries the call exactly once.

export const SESSION_EXPIRED_CODES = new Set(["INVALID_TOKEN", "MAIL_SESSION_EXPIRED"]);

/** True when a server-function *result* signals an expired/invalid session. */
export function isSessionExpiredResult(res: unknown): boolean {
  if (!res || typeof res !== "object") return false;
  const r = res as { ok?: unknown; code?: unknown };
  return r.ok === false && typeof r.code === "string" && SESSION_EXPIRED_CODES.has(r.code);
}

/** True when a *thrown* error signals an expired/invalid session. */
export function isSessionExpiredError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && SESSION_EXPIRED_CODES.has(code)) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && [...SESSION_EXPIRED_CODES].some((c) => msg.includes(c));
}

/**
 * Rewrites the token carried by a server-function argument. Handles both the
 * flat `{ data: { mailSessionToken } }` shape and the nested payload shapes
 * used by a few bridge functions.
 */
export function withFreshToken<T>(arg: T, token: string): T {
  if (!arg || typeof arg !== "object") return arg;
  const a = arg as Record<string, unknown>;
  const data = a.data;
  if (!data || typeof data !== "object") return arg;
  const d = { ...(data as Record<string, unknown>) };
  let touched = false;
  if ("mailSessionToken" in d) {
    d.mailSessionToken = token;
    touched = true;
  }
  for (const key of Object.keys(d)) {
    const v = d[key];
    if (v && typeof v === "object" && "mailSessionToken" in (v as Record<string, unknown>)) {
      d[key] = { ...(v as Record<string, unknown>), mailSessionToken: token };
      touched = true;
    }
  }
  return touched ? ({ ...a, data: d } as T) : arg;
}

export type Renewer = () => Promise<string | null>;

/** Wraps a renew function so concurrent callers share a single in-flight renewal. */
export function createSingleFlightRenewer(renew: Renewer): Renewer {
  let inflight: Promise<string | null> | null = null;
  return () => {
    if (inflight) return inflight;
    inflight = renew().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export interface SessionRetryDeps {
  renew: Renewer;
  onRenewFailed?: () => void;
}

/**
 * Calls `call(arg)`; on a session-expiry signal, renews once and retries with
 * the fresh token. Any other error/result passes through untouched.
 */
export async function callWithSessionRetry<A, R>(
  call: (arg: A) => Promise<R>,
  arg: A,
  deps: SessionRetryDeps,
): Promise<R> {
  let expired = false;
  let firstResult: R | undefined;
  try {
    firstResult = await call(arg);
    expired = isSessionExpiredResult(firstResult);
  } catch (err) {
    if (!isSessionExpiredError(err)) throw err;
    expired = true;
  }
  if (!expired) return firstResult as R;

  const token = await deps.renew();
  if (!token) {
    deps.onRenewFailed?.();
    if (firstResult !== undefined) return firstResult;
    throw new Error("MAIL_SESSION_EXPIRED");
  }
  return call(withFreshToken(arg, token));
}
