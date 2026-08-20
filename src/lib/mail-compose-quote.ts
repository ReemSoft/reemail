const QUOTED_CID_ATTR = "data-mm-source-cid";
const BLOCKED_REMOTE_IMAGE_ATTR = "data-mm-remote-image-blocked";
const REMOTE_IMAGE_URL_ATTR = "data-mm-remote-image-url";

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

const QUOTED_BIDI_BLOCK_SELECTOR = [
  "p",
  "div",
  "li",
  "blockquote",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
].join(",");

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

function blockRemoteImageSources(root: ParentNode): void {
  for (const source of root.querySelectorAll<HTMLElement>("source[srcset]")) {
    source.removeAttribute("srcset");
  }
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    image.removeAttribute("srcset");
    const src = (image.getAttribute("src") ?? "").trim();
    if (!/^(?:https?:)?\/\//i.test(src)) continue;
    // Keep the classified remote URL as inert internal metadata (never a live
    // `src`), so detached outgoing serialization can restore it for recipients
    // without the live Composer ever fetching it.
    image.setAttribute(REMOTE_IMAGE_URL_ATTR, src);
    image.removeAttribute("src");
    image.setAttribute(BLOCKED_REMOTE_IMAGE_ATTR, "1");
    image.style.visibility = "hidden";
    image.setAttribute("aria-hidden", "true");
  }
  for (const element of root.querySelectorAll<HTMLElement>("[background]")) {
    element.removeAttribute("background");
  }
}

function isolateSourceSelectors(root: ParentNode): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if ((anchor.getAttribute("href") ?? "").trim().startsWith("#")) anchor.removeAttribute("href");
  }
  for (const element of root.querySelectorAll<HTMLElement>("[class],[id]")) {
    element.removeAttribute("class");
    element.removeAttribute("id");
  }
}

/** Prevent native broken-image chrome before asynchronous CID hydration starts. */
export function markQuotedCidImagesPending(html: string): string {
  if (typeof document === "undefined") {
    return html
      .replace(
        /\ssrc=(["'])((?:https?:)?\/\/[^"']+)\1/gi,
        (_match, _quote, url) =>
          ` ${REMOTE_IMAGE_URL_ATTR}="${String(url).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
      )
      .replace(/\ssrc=(["'])cid:[^"']*\1/gi, "");
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const quotedContents = Array.from(
    template.content.querySelectorAll<HTMLElement>("[data-mm-quoted-content]"),
  );
  const sourceRoots: ParentNode[] = quotedContents.length ? quotedContents : [template.content];
  for (const root of sourceRoots) {
    isolateSourceSelectors(root);
    blockRemoteImageSources(root);
    markCidImagesPending(root);
  }
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

function hasExplicitSourceDirection(
  element: HTMLElement,
  fallbackElements?: ReadonlySet<HTMLElement>,
): boolean {
  const dir = element.getAttribute("dir")?.trim().toLowerCase();
  if ((dir === "ltr" || dir === "rtl" || dir === "auto") && !fallbackElements?.has(element)) {
    return true;
  }
  const direction = element.style.getPropertyValue("direction").trim().toLowerCase();
  return direction === "ltr" || direction === "rtl";
}

/** Give unformatted quoted text an isolated native bidi context without overriding source intent. */
export function applyQuotedDirectionFallback(
  root: ParentNode,
  inheritedSourceDirection = false,
): void {
  const fallbackElements = new Set<HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>(QUOTED_BIDI_BLOCK_SELECTOR)) {
    let hasSourceContext = inheritedSourceDirection;
    let current: HTMLElement | null = element;
    while (!hasSourceContext && current) {
      if (hasExplicitSourceDirection(current, fallbackElements)) hasSourceContext = true;
      if (current === root) break;
      current = current.parentElement;
    }
    if (!hasSourceContext) {
      element.setAttribute("dir", "auto");
      fallbackElements.add(element);
    }
  }
}

function wrapDocumentDirection(doc: Document, html: string): string {
  const body = doc.body;
  const documentElement = doc.documentElement;
  const dir = body.getAttribute("dir") ?? documentElement.getAttribute("dir");
  const direction =
    body.style.getPropertyValue("direction").trim() ||
    documentElement.style.getPropertyValue("direction").trim();
  const textAlign =
    body.style.getPropertyValue("text-align").trim() ||
    documentElement.style.getPropertyValue("text-align").trim();
  if (!dir && !direction && !textAlign) return html;
  const wrapper = doc.createElement("div");
  if (dir) wrapper.setAttribute("dir", dir);
  if (direction && safeStyleValue(direction)) wrapper.style.setProperty("direction", direction);
  if (textAlign && safeStyleValue(textAlign)) wrapper.style.setProperty("text-align", textAlign);
  wrapper.innerHTML = html;
  return wrapper.outerHTML;
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
  for (const element of [
    doc.documentElement,
    doc.body,
    ...Array.from(doc.body.querySelectorAll<HTMLElement>("*")),
  ]) {
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
  isolateSourceSelectors(doc.body);
  removeStructuralIndentation(doc.body);
  applyQuotedDirectionFallback(doc.body, hasExplicitSourceDirection(doc.documentElement));
  blockRemoteImageSources(doc.body);
  markCidImagesPending(doc.body);
  return wrapDocumentDirection(doc, doc.body.innerHTML.trim());
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

/**
 * An unavailable CID inside historical reply/forward content must not poison
 * the entire Draft. Preserve meaningful alt text and discard only that stale
 * image. Authored/current-message images are intentionally left untouched so
 * their normal resource dependency continues to fail closed.
 */
export function removeUnresolvedQuotedCidImage(image: HTMLImageElement): boolean {
  if (!image.closest("[data-mm-quoted-content]")) return false;
  const alt = image.getAttribute("alt")?.trim();
  if (alt) image.replaceWith(document.createTextNode(alt));
  else image.remove();
  return true;
}

export const QUOTED_SOURCE_CID_ATTR = QUOTED_CID_ATTR;
export const QUOTED_BLOCKED_REMOTE_IMAGE_ATTR = BLOCKED_REMOTE_IMAGE_ATTR;
export const QUOTED_REMOTE_IMAGE_URL_ATTR = REMOTE_IMAGE_URL_ATTR;
