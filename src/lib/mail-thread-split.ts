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

/** Locate the outermost <blockquote> element, honouring nesting. */
function findFirstBlockquote(
  html: string,
): { start: number; innerStart: number; innerEnd: number; end: number } | null {
  const open = /<blockquote\b[^>]*>/i.exec(html);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  const re = /<\/?blockquote\b[^>]*>/gi;
  re.lastIndex = innerStart;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0)
        return { start: open.index, innerStart, innerEnd: m.index, end: re.lastIndex };
    } else depth++;
  }
  return { start: open.index, innerStart, innerEnd: html.length, end: html.length };
}

/** First marker position strictly after the start of the fragment, or -1. */
function nextMarkerIndex(html: string): number {
  let best = -1;
  for (const re of MARKERS) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const rx = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null) {
      if (m.index > 0) {
        if (best === -1 || m.index < best) best = m.index;
        break;
      }
      if (rx.lastIndex <= m.index) rx.lastIndex = m.index + 1;
    }
  }
  return best;
}


/**
 * Split a fragment into "this turn" (its own attribution header + content) and
 * the attribution that introduces the next, older turn.
 */
function attributionSplit(head: string): { turn: string; attribution: string } {
  const cut = nextMarkerIndex(head);
  if (cut === -1) return { turn: head, attribution: "" };
  return { turn: head.slice(0, cut), attribution: head.slice(cut) };
}

/**
 * Split a body into an ordered list of thread turns (newest first).
 *
 * Real reply chains nest each older turn inside another <blockquote>, so a
 * flat scan finds only the outermost quote and lumps the entire history into a
 * single segment. Here every iteration unwraps exactly one nesting level, so
 * each reply/forward becomes its own entity.
 */
export function splitThreadSegments(html: string, max = 12): string[] {
  const out: string[] = [];
  let rest = html || "";

  for (let i = 0; i < max; i++) {
    if (!rest.trim()) break;
    const bq = findFirstBlockquote(rest);

    if (bq) {
      const head = rest.slice(0, bq.start);
      const inner = rest.slice(bq.innerStart, bq.innerEnd);
      const tail = rest.slice(bq.end);
      const { turn, attribution } = attributionSplit(head);
      const next = attribution + inner + tail;
      if (textLength(turn) >= 1) out.push(turn);
      if (next === rest) break;
      rest = next;
      continue;
    }

    const { turn, attribution } = attributionSplit(rest);
    if (!attribution) break;
    if (textLength(turn) >= 1) out.push(turn);
    if (attribution === rest) break;
    rest = attribution;
  }

  if (textLength(rest) >= 1 || out.length === 0) out.push(rest);
  return out.filter((s) => s && s.trim().length > 0);
}

