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
  /<div[^>]*class="[^"]*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|OutlookMessageHeader|mm_quote)[^"]*"/i,
  /<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"/i,
  /<hr[^>]*id="stopSpelling"/i,
  /-{2,}\s*(?:Original Message|Forwarded message|رسالة أصلية|رسالة معاد توجيهها)\s*-{2,}/i,
  /(?:^|>)\s*(?:On|في)\s[^<]{5,120}?(?:wrote|كتب)\s*:/im,
  /_{20,}/,
];

/** Structural quote starts safe enough for display-only historical trimming. */
const HISTORICAL_QUOTE_MARKERS: RegExp[] = [
  /<blockquote\b/i,
  /<div[^>]*class="[^"]*(?:gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix|OutlookMessageHeader|mm_quote)[^"]*"/i,
  /<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"/i,
  /<hr[^>]*id="stopSpelling"/i,
  /<(?:div|p)\b[^>]*>\s*-{2,}\s*(?:Original Message|Forwarded message|رسالة أصلية|رسالة معاد توجيهها)\s*-{2,}/i,
  /-{2,}\s*(?:Original Message|Forwarded message|رسالة أصلية|رسالة معاد توجيهها)\s*-{2,}/i,
  /_{20,}/,
];

const PLAIN_QUOTE_LINE = /(?:\r?\n|<br\s*\/?>)\s*(?:&gt;|>)[ \t]/i;

function visibleText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isReplyAttribution(text: string): boolean {
  if (text.length < 6 || text.length > 600) return false;
  return (
    /^On\s+[\s\S]{3,500}\bwrote\s*:\s*$/i.test(text) ||
    /^في\s+[\s\S]{3,500}كتب[\s\S]{0,250}:\s*$/u.test(text)
  );
}

/** Find a complete div/p that is the final block before the quote marker. */
function trailingAttributionBlockStart(prefix: string): number | null {
  const tags = /<\/?(div|p)\b[^>]*>/gi;
  const stack: Array<{ name: string; start: number; openingTag: string }> = [];
  let candidate: { start: number; openingTag: string; html: string } | null = null;
  let match: RegExpExecArray | null;

  while ((match = tags.exec(prefix))) {
    const closing = match[0].startsWith("</");
    const name = match[1].toLowerCase();
    if (!closing) {
      stack.push({ name, start: match.index, openingTag: match[0] });
      continue;
    }
    let index = stack.length - 1;
    while (index >= 0 && stack[index].name !== name) index -= 1;
    if (index < 0) continue;
    const opening = stack[index];
    stack.length = index;
    if (!prefix.slice(tags.lastIndex).trim()) {
      candidate = {
        start: opening.start,
        openingTag: opening.openingTag,
        html: prefix.slice(opening.start, tags.lastIndex),
      };
    }
  }

  if (!candidate) return null;
  if (/\bclass="[^"]*(?:gmail_attr|moz-cite-prefix)[^"]*"/i.test(candidate.openingTag)) {
    return candidate.start;
  }
  return isReplyAttribution(visibleText(candidate.html)) ? candidate.start : null;
}

function trailingAttributionLineStart(prefix: string): number | null {
  const match = /(?:^|\r?\n)([^\r\n]{0,600})\s*$/.exec(prefix);
  if (!match || !isReplyAttribution(visibleText(match[1]))) return null;
  return match.index === 0 ? 0 : match.index + match[0].indexOf(match[1]);
}

function earliestMatch(input: string, patterns: readonly RegExp[]): number {
  let cut = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match && (cut < 0 || match.index < cut)) cut = match.index;
  }
  return cut;
}

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

/**
 * Return only the content authored by one historical conversation turn.
 * The source string is never mutated or persisted. Attribution text is
 * removed only when it is directly attached to a recognized quote structure.
 */
export function trimHistoricalQuotedContent(html: string): string {
  const input = html || "";
  if (!input.trim()) return input;

  const structuralCut = earliestMatch(input, HISTORICAL_QUOTE_MARKERS);
  const plainMatch = PLAIN_QUOTE_LINE.exec(input);
  const plainCut = plainMatch?.index ?? -1;
  let cut =
    structuralCut < 0 ? plainCut : plainCut < 0 ? structuralCut : Math.min(structuralCut, plainCut);
  if (cut <= 0) return input;

  const prefix = input.slice(0, cut);
  const attributionStart =
    trailingAttributionBlockStart(prefix) ?? trailingAttributionLineStart(prefix);
  if (attributionStart !== null) cut = attributionStart;

  const latest = input.slice(0, cut);
  const quoted = input.slice(cut);
  if (textLength(latest) < 2 || textLength(quoted) < 2) return input;
  return latest.replace(/[ \t]+$/g, "").replace(/\r?\n\r?\n$/g, "\n");
}
