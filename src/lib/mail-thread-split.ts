/**
 * mail-thread-split — separate the newest part of a message from its quoted
 * history, the way Gmail/Outlook do with the "•••" collapsed block.
 *
 * Pure string analysis so it can run before rendering the sandboxed iframe
 * and stays unit-testable in node. Input MUST already be sanitized HTML.
 */

/** Markers that indicate the start of quoted history inside an email body. */
const MARKERS: RegExp[] = [
  /<blockquote\b/i,
  /<div[^>]*class="[^"]*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|OutlookMessageHeader)[^"]*"/i,
  /<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"/i,
  /<hr[^>]*id="stopSpelling"/i,
  /-{2,}\s*(?:Original Message|Forwarded message|رسالة أصلية|رسالة معاد توجيهها)\s*-{2,}/i,
  /(?:^|>)\s*(?:On|في)\s[^<]{5,120}?(?:wrote|كتب)\s*:/im,
  /_{20,}/,
];

/** Strip tags/entities to measure whether a fragment carries real content. */
function textLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, "")
    .trim().length;
}

export interface ThreadSplit {
  /** Newest message content (always rendered). */
  latest: string;
  /** Quoted history, empty when the message has none. */
  quoted: string;
}

/**
 * Split a message body into its newest part and the quoted history.
 * Returns `quoted: ""` when no reliable marker exists, or when splitting
 * would leave the newest part empty (i.e. the whole body IS the quote).
 */
export function splitQuotedHtml(html: string): ThreadSplit {
  const input = html || "";
  if (!input.trim()) return { latest: input, quoted: "" };

  let cut = -1;
  for (const re of MARKERS) {
    const m = re.exec(input);
    if (m && m.index >= 0 && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return { latest: input, quoted: "" };

  const latest = input.slice(0, cut);
  const quoted = input.slice(cut);
  // A quote that is not preceded by any real new content is not a "thread".
  if (textLength(latest) < 2) return { latest: input, quoted: "" };
  if (textLength(quoted) < 2) return { latest: input, quoted: "" };
  return { latest, quoted };
}
