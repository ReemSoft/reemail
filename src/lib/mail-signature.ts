/**
 * Email signature block helpers.
 *
 * The signature is stored once per mail account (table `mail_signatures`) and inserted
 * into the composer on demand. The block is marked with a CLASS (not a data
 * attribute) because the outgoing sanitizer runs with `ALLOW_DATA_ATTR: false`,
 * so only classes survive a draft round-trip — which is what lets a second
 * "insert signature" click REPLACE the previous block instead of stacking.
 *
 * Pure string/DOM helpers: no network, no React, no app state.
 */
import DOMPurify from "dompurify";

export const SIGNATURE_CLASS = "mm_signature";
export const SIGNATURE_GAP_CLASS = "mm_signature_gap";
/** Quote wrapper class produced by mail-quote.ts (reply/forward history). */
const QUOTE_CLASS = "mm_quote";

/** Sanitize signature HTML: inline formatting is kept, active content is not. */
export function sanitizeSignatureHtml(html: string): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base", "style"],
    FORBID_ATTR: ["srcdoc", "formaction", "onerror", "onload", "onclick", "onmouseover", "onfocus"],
    ALLOW_DATA_ATTR: false,
  });
}

/** True when the signature carries no visible content. */
export function isSignatureEmpty(html: string): boolean {
  if (!html) return true;
  const text = html
    .replace(/<br\s*\/?>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
  return text.length === 0 && !/<img\b/i.test(html);
}

/**
 * Insert (or replace) the signature block inside a composer editor element.
 *
 * Placement: after the last line of the user's own text, separated by two
 * blank lines, and BEFORE any quoted reply/forward history.
 */
export function insertSignatureIntoEditor(root: HTMLElement, signatureHtml: string): void {
  const clean = sanitizeSignatureHtml(signatureHtml);
  if (!clean) return;

  // Drop any previously inserted signature (and its spacer) so repeated
  // clicks replace rather than accumulate.
  root.querySelectorAll(`.${SIGNATURE_CLASS}, .${SIGNATURE_GAP_CLASS}`).forEach((n) => n.remove());

  const doc = root.ownerDocument;
  const gap = doc.createElement("div");
  gap.className = SIGNATURE_GAP_CLASS;
  gap.innerHTML = "<div><br></div><div><br></div>";

  const block = doc.createElement("div");
  block.className = SIGNATURE_CLASS;
  block.setAttribute("dir", "auto");
  block.innerHTML = clean;

  const quote = root.querySelector(`.${QUOTE_CLASS}`);
  if (quote?.parentNode) {
    quote.parentNode.insertBefore(gap, quote);
    quote.parentNode.insertBefore(block, quote);
  } else {
    root.appendChild(gap);
    root.appendChild(block);
  }
}
