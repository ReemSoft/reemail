/**
 * Signature storage (browser only).
 *
 * One row per verified mail account in `mail_signatures`. The
 * value is fetched LAZILY (first time the composer needs it) and then kept in
 * a module-level cache for the rest of the tab session, so opening the app,
 * opening a message, or opening the composer again costs zero extra requests.
 */
import { sanitizeSignatureHtml } from "./mail-signature";
import { loadMailSignature, saveMailSignature } from "./mail-signature.functions";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** Cached signature HTML, or null when it has not been loaded yet. */
export function peekSignature(mailSessionToken: string): string | null {
  return cache.get(mailSessionToken) ?? null;
}

export async function loadSignature(mailSessionToken: string): Promise<string> {
  const cached = cache.get(mailSessionToken);
  if (cached !== undefined) return cached;
  const pending = inflight.get(mailSessionToken);
  if (pending) return pending;
  const request = loadMailSignature({ data: { mailSessionToken } })
    .then((result) => {
      if (!result.ok) throw new Error(result.code);
      const clean = sanitizeSignatureHtml(result.html);
      cache.set(mailSessionToken, clean);
      return clean;
    })
    .finally(() => inflight.delete(mailSessionToken));
  inflight.set(mailSessionToken, request);
  return request;
}

export async function saveSignature(mailSessionToken: string, html: string): Promise<string> {
  const clean = sanitizeSignatureHtml(html);
  const result = await saveMailSignature({ data: { mailSessionToken, html: clean } });
  if (!result.ok) throw new Error(result.code);
  cache.set(mailSessionToken, clean);
  return clean;
}
