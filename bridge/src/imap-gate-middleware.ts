/**
 * Express middleware wrapping the IMAP concurrency limiter.
 *
 * Extracted so it can be unit / integration tested without booting the
 * full bridge. Contract (locked by tests):
 *
 *   * Waiter cancellation is tied to CLIENT disconnect, not response
 *     completion. We listen on `req` for `aborted` and `close`, wire them
 *     to an AbortController, and pass `controller.signal` to `acquire()`.
 *   * The moment `acquire()` settles — admitted OR rejected — we detach
 *     both listeners so no reference leaks past the wait window.
 *   * After admission, `release` is triggered by whichever of
 *     `res.finish` / `res.close` fires first, exactly once.
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
  const acct = ((req as unknown as { body?: { account?: Record<string, unknown> } }).body ?? {})
    .account ?? {};
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

    // Client-disconnect signal: fires when the socket goes away BEFORE
    // we've admitted the caller. We intentionally listen on `req`, not
    // `res`, because `res.close` only means "response ended" — that
    // could equally fire on a successful send after admission.
    const onClientGone = () => {
      try {
        ac.abort();
      } catch {
        /* noop */
      }
    };
    req.once("aborted", onClientGone);
    req.once("close", onClientGone);

    const detachWaiterListeners = () => {
      req.off("aborted", onClientGone);
      req.off("close", onClientGone);
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
