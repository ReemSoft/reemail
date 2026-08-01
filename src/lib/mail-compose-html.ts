/**
 * Outgoing email HTML builder.
 *
 * Problem this solves: the composer is a `contentEditable` div whose visual
 * appearance comes from the APP's stylesheet (Tailwind preflight, the
 * `whitespace-pre-wrap` utility, `text-sm` line-height, `.composer-editor`
 * list/blockquote/link rules). None of that CSS travels with the message, and
 * every mail client strips <style> blocks or applies its own reset — so the
 * recipient sees one dense, unspaced block.
 *
 * Fix: at SEND time only, convert the editor fragment into a self-contained
 * email document whose formatting is carried by INLINE styles (the only thing
 * every mail client honours). Drafts keep storing the raw fragment so
 * re-opening a draft round-trips losslessly.
 *
 * Pure string transform: no DOM, no network — unit testable in node.
 */

/** Base typography applied to the whole message body. */
export const EMAIL_BODY_STYLE = [
  "font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif",
  "font-size:14px",
  "line-height:1.7",
  "color:#111111",
  // Mirrors the composer's `whitespace-pre-wrap`: keeps the blank lines and
  // indentation the user actually typed instead of collapsing them.
  "white-space:pre-wrap",
  "word-wrap:break-word",
].join(";");

/**
 * Per-tag inline defaults. These recreate what the app stylesheet gives the
 * composer. Existing inline styles authored by the user always win (they are
 * appended last).
 */
const TAG_STYLES: Record<string, string> = {
  p: "margin:0 0 12px",
  div: "",
  h1: "margin:0 0 12px;font-size:24px;line-height:1.3;font-weight:700",
  h2: "margin:0 0 12px;font-size:20px;line-height:1.35;font-weight:700",
  h3: "margin:0 0 10px;font-size:17px;line-height:1.4;font-weight:700",
  h4: "margin:0 0 10px;font-size:15px;line-height:1.4;font-weight:700",
  h5: "margin:0 0 8px;font-size:14px;font-weight:700",
  h6: "margin:0 0 8px;font-size:13px;font-weight:700",
  ul: "margin:0 0 12px;padding-inline-start:24px;list-style:disc;white-space:normal",
  ol: "margin:0 0 12px;padding-inline-start:24px;list-style:decimal;white-space:normal",
  li: "margin:0 0 4px",
  blockquote:
    "margin:8px 0;padding-inline-start:12px;border-inline-start:3px solid #d4d4d8;color:#52525b",
  a: "color:#2563eb;text-decoration:underline",
  img: "max-width:100%;height:auto",
  table: "border-collapse:collapse;white-space:normal",
  td: "padding:4px 8px;vertical-align:top",
  th: "padding:4px 8px;vertical-align:top;text-align:inherit",
  pre: "margin:0 0 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px",
  code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px",
  hr: "border:0;border-top:1px solid #e4e4e7;margin:16px 0",
};

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const STYLE_ATTR_RE = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/i;

/**
 * Merge our per-tag defaults into every matching opening tag. Author styles
 * are placed AFTER the defaults so they override them by CSS cascade order.
 */
export function inlineBlockStyles(fragment: string): string {
  return fragment.replace(TAG_RE, (full, rawName: string, attrs: string, selfClose: string) => {
    const name = rawName.toLowerCase();
    const base = TAG_STYLES[name];
    if (!base) return full;

    const m = attrs.match(STYLE_ATTR_RE);
    let nextAttrs: string;
    if (m) {
      const existing = (m[3] ?? m[4] ?? "").trim().replace(/;$/, "");
      const merged = existing ? `${base};${existing}` : base;
      nextAttrs = attrs.replace(STYLE_ATTR_RE, `$1"${merged}"`);
    } else {
      nextAttrs = `${attrs} style="${base}"`;
    }
    return `<${rawName}${nextAttrs}${selfClose}>`;
  });
}

export interface BuildEmailHtmlOptions {
  /** Message direction; defaults to rtl to match the product's primary locale. */
  dir?: "rtl" | "ltr";
}

/**
 * Wrap a sanitized composer fragment into a standalone, client-safe email
 * document with all formatting carried inline.
 */
export function buildEmailHtmlDocument(
  fragment: string,
  options: BuildEmailHtmlOptions = {},
): string {
  const dir = options.dir === "ltr" ? "ltr" : "rtl";
  if (!fragment || !fragment.trim()) return "";
  const body = inlineBlockStyles(fragment);
  const align = dir === "rtl" ? "right" : "left";
  return [
    "<!DOCTYPE html>",
    `<html dir="${dir}">`,
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:0">',
    `<div dir="${dir}" style="${EMAIL_BODY_STYLE};text-align:${align}">`,
    body,
    "</div></body></html>",
  ].join("");
}

const BLOCK_CLOSE_RE = /<\/(p|div|li|ul|ol|h[1-6]|blockquote|tr|pre|table)\s*>/gi;
const BR_RE = /<br\s*\/?>/gi;

/** Plain-text alternative that preserves the line structure of the HTML. */
export function htmlToPlainText(fragment: string): string {
  if (!fragment) return "";
  return fragment
    .replace(BR_RE, "\n")
    .replace(BLOCK_CLOSE_RE, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
