/**
 * Express middleware wrapping the IMAP concurrency limiter.
 *
 * Extracted so it can be unit / integration tested without booting the
 * full bridge. Contract (locked by tests):
 *
 *   * Waiter cancellation is tied to the CLIENT socket, not response
 *     completion. When the client disconnects while we are still waiting
 *     for a permit, the AbortController fires and `acquire()` rejects
 *     with `ImapBusyError({ reason: "cancelled" })`.
 *
 *   * Signals used:
 *       - `req.once("aborted", ...)`
 *           Legacy Node signal for premature client abort. Still emitted
 *           in Node ≥ 20 on request-level abort; kept for defence in depth.
 *       - `req.socket.once("close", ...)`
 *           The actual TCP-socket close event. This is the reliable
 *           client-disconnect primitive on the server side.
 *
 *     NOTE: We deliberately do NOT listen on `req.once("close", ...)`.
 *     Empirically (Node 22 + Express 4 + `express.json()` upstream), the
 *     server-side IncomingMessage emits `'close'` immediately after the
 *     body parser finishes draining the request stream — long before
 *     the client disconnects. Wiring it to `abort()` would cancel every
 *     waiter the instant it queued. See `imap-gate-middleware.test.ts`
 *     for the regression fixture that locks this behaviour.
 *
 *   * The moment `acquire()` settles — admitted OR rejected — we detach
 *     both listeners so no reference leaks past the wait window.
 *
 *   * After admission, `release` is triggered by whichever of
 *     `res.finish` / `res.close` fires first, exactly once. `res.close`
 *     here is safe: it fires when the response stream is closed
 *     (either after `finish` on success, or on late socket drop) — it
 *     is NOT used as a pre-admission cancellation signal.
 *
 *   * On `ImapBusyError`: HTTP 503 + `IMAP_BUSY` + `Retry-After` header.
 *   * On any other error: forwarded via `next(err)`.
 */
import type { RequestHandler } from "express";
import { ImapBusyError, type ImapGates, type ImapPriority } from "./imap-gates.js";

export interface GateMetaExtractor {
  (req: Parameters<RequestHandler>[0]): {
    host: string;
    company: string;
    account: string;
  };
}

export const defaultMetaExtractor: GateMetaExtractor = (req) => {
  const acct =
    ((req as unknown as { body?: { account?: Record<string, unknown> } }).body ?? {}).account ?? {};
  return {
    host: String((acct as Record<string, unknown>).imap_host ?? "unknown"),
    company: String(
      (acct as Record<string, unknown>).company_id ??
        (acct as Record<string, unknown>).companyId ??
        "",
    ),
    account: String((acct as Record<string, unknown>).email_address ?? "unknown"),
  };
};

export function createImapGateMiddleware(
  gates: ImapGates,
  priority: ImapPriority,
  extractMeta: GateMetaExtractor = defaultMetaExtractor,
): RequestHandler {
  return async (req, res, next) => {
    const meta = extractMeta(req);
    const ac = new AbortController();

    const onClientGone = () => {
      try {
        ac.abort();
      } catch {
        /* noop */
      }
    };
    req.once("aborted", onClientGone);
    // req.socket may be undefined in exotic transports; guard defensively.
    const sock = req.socket;
    if (sock) sock.once("close", onClientGone);

    const detachWaiterListeners = () => {
      req.off("aborted", onClientGone);
      if (sock) sock.off("close", onClientGone);
    };

    let release: (() => void) | null = null;
    try {
      release = await gates.acquire({ ...meta, priority, signal: ac.signal });
    } catch (err) {
      detachWaiterListeners();
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof ImapBusyError) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
        return res.status(503).json({
          ok: false,
          error: "IMAP_BUSY",
          message: "الخادم مشغول، حاول بعد قليل",
        });
      }
      return next(err);
    }

    // Admitted. Waiter listeners are no longer relevant; the response
    // path owns the permit lifecycle from here.
    detachWaiterListeners();

    let released = false;
    const doRelease = () => {
      if (released) return;
      released = true;
      release!();
    };
    res.once("finish", doRelease);
    res.once("close", doRelease);
    next();
  };
}
