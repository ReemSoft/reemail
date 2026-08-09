const QUOTED_CID_ATTR = "data-mm-source-cid";

const SAFE_STYLE_PROPERTIES = new Set([
  "display",
  "box-sizing",
  "width",
  "max-width",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-width",
  "border-style",
  "border-color",
  "border-collapse",
  "border-spacing",
  "background-color",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "text-align",
  "text-decoration",
  "vertical-align",
  "white-space",
  "word-break",
  "overflow-wrap",
  "list-style",
  "list-style-type",
  "list-style-position",
  "table-layout",
  "direction",
]);

const STRUCTURAL_PARENTS = new Set([
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "COLGROUP",
  "UL",
  "OL",
]);
const BLOCK_ELEMENTS = new Set([
  "ADDRESS",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "UL",
]);

function normalizedCid(value: string): string {
  return value.trim().replace(/^<|>$/g, "").toLowerCase();
}

function safeStyleValue(value: string): boolean {
  return !/(?:url\s*\(|expression\s*\(|javascript:|behavior\s*:|@import)/i.test(value);
}

function addSafeProperty(properties: Set<string>, property: string): void {
  if (SAFE_STYLE_PROPERTIES.has(property)) {
    properties.add(property);
    return;
  }
  if (property === "font") {
    for (const expanded of ["font-family", "font-size", "font-weight", "font-style", "line-height"])
      properties.add(expanded);
  } else if (property === "background") {
    properties.add("background-color");
  } else if (property === "word-wrap") {
    properties.add("overflow-wrap");
  }
}

function markCidImagesPending(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src^="cid:" i]')) {
    const cid = normalizedCid(image.getAttribute("src")?.slice(4) ?? "");
    if (!cid) {
      image.removeAttribute("src");
      image.style.visibility = "hidden";
      continue;
    }
    image.setAttribute(QUOTED_CID_ATTR, cid);
    image.removeAttribute("src");
    image.style.visibility = "hidden";
    image.setAttribute("aria-busy", "true");
  }
}

/** Prevent native broken-image chrome before asynchronous CID hydration starts. */
export function markQuotedCidImagesPending(html: string): string {
  if (typeof document === "undefined") return html.replace(/\ssrc=(['"])cid:([^'"]+)\1/gi, "");
  const template = document.createElement("template");
  template.innerHTML = html;
  markCidImagesPending(template.content);
  return template.innerHTML;
}

function collectMatchingProperties(element: HTMLElement, rules: readonly CSSRule[]): Set<string> {
  const properties = new Set<string>();
  for (const property of Array.from(element.style)) addSafeProperty(properties, property);
  const visit = (rule: CSSRule) => {
    const candidate = rule as CSSStyleRule & { cssRules?: CSSRuleList };
    if (candidate.selectorText && candidate.style) {
      try {
        if (element.matches(candidate.selectorText)) {
          for (const property of Array.from(candidate.style)) {
            addSafeProperty(properties, property);
          }
        }
      } catch {
        // Unsupported email selectors are ignored; the fragment remains safe and usable.
      }
    }
    if (candidate.cssRules) for (const nested of Array.from(candidate.cssRules)) visit(nested);
  };
  for (const rule of rules) visit(rule);
  return properties;
}

function removeStructuralIndentation(root: ParentNode): void {
  const owner = root instanceof Document ? root : (root.ownerDocument ?? document);
  const walker = owner.createTreeWalker(root, 4);
  const removable: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (!text.data.trim()) {
      const parent = text.parentElement;
      const previous = text.previousElementSibling;
      const next = text.nextElementSibling;
      if (
        parent &&
        (STRUCTURAL_PARENTS.has(parent.tagName) ||
          (previous &&
            next &&
            BLOCK_ELEMENTS.has(previous.tagName) &&
            BLOCK_ELEMENTS.has(next.tagName)))
      ) {
        removable.push(text);
      }
    }
    current = walker.nextNode();
  }
  for (const text of removable) text.remove();
}

/** Export the isolated document after converting only approved CSS into inline declarations. */
export function exportPreparedQuotedDocument(doc: Document): string {
  const rules: CSSRule[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      rules.push(...Array.from(sheet.cssRules));
    } catch {
      // No external stylesheets are permitted, but fail closed if a browser rejects access.
    }
  }
  for (const element of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (element.tagName === "STYLE") continue;
    const computed = doc.defaultView?.getComputedStyle(element);
    if (!computed) continue;
    const safeDeclarations = Array.from(
      collectMatchingProperties(element, rules),
      (property) => [property, computed.getPropertyValue(property).trim()] as const,
    );
    element.removeAttribute("style");
    for (const [property, value] of safeDeclarations) {
      if (value && safeStyleValue(value)) element.style.setProperty(property, value);
    }
  }
  for (const unsafe of doc.body.querySelectorAll("style,script,link,object,embed,iframe"))
    unsafe.remove();
  removeStructuralIndentation(doc.body);
  markCidImagesPending(doc.body);
  return doc.body.innerHTML.trim();
}

const FORMATTER_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
].join("; ");

/**
 * Let sanitized email CSS compute in a short-lived, no-network document, then
 * return a self-contained fragment. Original style tags never enter Composer.
 */
export async function prepareQuotedEmailForComposer(hardenedHtml: string): Promise<string> {
  if (typeof document === "undefined") return markQuotedCidImagesPending(hardenedHtml);
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FORMATTER_CSP}"></head><body>${hardenedHtml}</body></html>`;
  document.body.append(frame);
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };
      frame.addEventListener("load", finish, { once: true });
      timeout = window.setTimeout(finish, 100);
    });
    return frame.contentDocument
      ? exportPreparedQuotedDocument(frame.contentDocument)
      : markQuotedCidImagesPending(hardenedHtml);
  } finally {
    frame.remove();
  }
}

export const QUOTED_SOURCE_CID_ATTR = QUOTED_CID_ATTR;
