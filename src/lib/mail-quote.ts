/**
 * mail-quote — build the quoted history block for Reply / Forward.
 *
 * Why this exists: the previous implementation ran `textContent` over the raw
 * message HTML. For any real-world message that carries a `<style>` block
 * (virtually every transactional / marketing mail) that dumps the raw CSS
 * source — `@media{...}`, `#outlook a{padding:0}` — straight into the
 * composer, which is exactly the "strange symbols and codes" the user sees.
 *
 * The correct behaviour (Gmail / Outlook / Apple Mail) is to quote the
 * original as HTML inside a `<blockquote>`, not to flatten it to text. This
 * module does that with pure string transforms so it stays unit-testable.
 *
 * Callers must pass ALREADY SANITIZED html (DOMPurify) — this module only
 * shapes the quote, it is not a security boundary.
 */

export interface QuoteAuthor {
  name?: string;
  email: string;
}

export interface QuoteMeta {
  from: QuoteAuthor;
  to?: QuoteAuthor[];
  cc?: QuoteAuthor[];
  subject?: string;
  date: string;
}

const DOCTYPE_RE = /<!DOCTYPE[^>]*>/gi;
const HEAD_RE = /<head[\s\S]*?<\/head>/gi;
const STYLE_RE = /<style[\s\S]*?<\/style>/gi;
const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;
const HTML_TAGS_RE =
  /<\/?(?:p|div|br|table|span|a|img|ul|ol|li|h[1-6]|blockquote|strong|b|em|i)\b/i;

/** True when the string looks like HTML rather than plain text. */
export function looksLikeHtml(input: string): boolean {
  return HTML_TAGS_RE.test(input || "");
}

export function escapeHtml(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Reduce a full message document to a body fragment safe to nest inside the
 * composer: no doctype, no <head>, no <style>/<script>, no comments.
 */
export function extractBodyFragment(html: string): string {
  if (!html) return "";
  let out = html
    .replace(COMMENT_RE, "")
    .replace(SCRIPT_RE, "")
    .replace(STYLE_RE, "")
    .replace(DOCTYPE_RE, "");
  const body = out.match(BODY_RE);
  if (body) out = body[1];
  out = out.replace(/<\/?(?:html|body)[^>]*>/gi, "");
  return out.trim();
}

/** Normalise any message body (HTML or plain text) into a safe fragment. */
export function toQuotableFragment(body: string): string {
  if (!body) return "";
  if (looksLikeHtml(body)) return extractBodyFragment(body);
  return escapeHtml(body.trim()).replace(/\r?\n/g, "<br>");
}

function formatAddress(a: QuoteAuthor): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function formatDate(date: string, locale: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  try {
    return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return d.toISOString();
  }
}

function bidiIsolate(text: string): string {
  return `<bdi>${escapeHtml(text)}</bdi>`;
}

/** Marker class used by the viewer to detect a quoted history block. */
export const QUOTE_CLASS = "mm_quote";

const BLOCKQUOTE_STYLE = "margin:0;color:#3f3f46;white-space:normal";

const QUOTED_CONTENT_STYLE =
  "padding-inline-start:12px;border-inline-start:2px solid #d4d4d8;white-space:normal;text-align:start";

export const QUOTED_CONTENT_ATTR = "data-mm-quoted-content";

/**
 * Reply body: two empty lines for the user's answer, then an attribution
 * line and the original message inside a blockquote.
 */
export function buildReplyQuoteHtml(
  body: string,
  meta: QuoteMeta,
  locale = "ar",
  attributionLabel = "wrote:",
): string {
  const fragment = toQuotableFragment(body);
  const attribution = `${bidiIsolate(formatDate(meta.date, locale))} — ${bidiIsolate(
    formatAddress(meta.from),
  )} ${escapeHtml(attributionLabel)}`;
  return [
    "<div><br></div><div><br></div>",
    `<div class="${QUOTE_CLASS}">`,
    `<div style="color:#71717a;font-size:12px;margin:0 0 8px">${attribution}</div>`,
    `<blockquote style="${BLOCKQUOTE_STYLE}"><div ${QUOTED_CONTENT_ATTR}="1" dir="auto" style="${QUOTED_CONTENT_STYLE}">${fragment}</div></blockquote>`,
    "</div>",
  ].join("");
}

export interface ForwardLabels {
  header: string;
  from: string;
  date: string;
  subject: string;
  to: string;
  cc: string;
}

/** Forward body: standard forwarded-message header table + original HTML. */
export function buildForwardQuoteHtml(
  body: string,
  meta: QuoteMeta,
  locale = "ar",
  labels: ForwardLabels = {
    header: "---------- Forwarded message ----------",
    from: "From:",
    date: "Date:",
    subject: "Subject:",
    to: "To:",
    cc: "Cc:",
  },
): string {
  const fragment = toQuotableFragment(body);
  const rows: string[] = [
    `${escapeHtml(labels.from)} ${bidiIsolate(formatAddress(meta.from))}`,
    `${escapeHtml(labels.date)} ${bidiIsolate(formatDate(meta.date, locale))}`,
  ];
  if (meta.subject) rows.push(`${escapeHtml(labels.subject)} ${bidiIsolate(meta.subject)}`);
  if (meta.to?.length) {
    rows.push(`${escapeHtml(labels.to)} ${bidiIsolate(meta.to.map(formatAddress).join(", "))}`);
  }
  if (meta.cc?.length) {
    rows.push(`${escapeHtml(labels.cc)} ${bidiIsolate(meta.cc.map(formatAddress).join(", "))}`);
  }
  return [
    "<div><br></div><div><br></div>",
    `<div class="${QUOTE_CLASS}">`,
    `<div style="color:#71717a;font-size:12px;margin:0 0 8px">${escapeHtml(labels.header)}</div>`,
    `<div style="color:#3f3f46;font-size:12px;margin:0 0 12px">${rows.join("<br>")}</div>`,
    `<blockquote style="${BLOCKQUOTE_STYLE}"><div ${QUOTED_CONTENT_ATTR}="1" dir="auto" style="${QUOTED_CONTENT_STYLE}">${fragment}</div></blockquote>`,
    "</div>",
  ].join("");
}
