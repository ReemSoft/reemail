/**
 * email-viewer-security — hardening helpers for the sandboxed HTML email viewer.
 *
 * These functions are used by `EmailBodyFrame` in `src/routes/mail.tsx` to
 * defend against malicious HTML/CSS in incoming mail. All CSS `url(...)`
 * references pointing to remote resources are stripped so a message cannot
 * exfiltrate the recipient's IP or track opens via `background-image`.
 * `@import` rules are removed for the same reason.
 *
 * The srcDoc is served inside a `sandbox` iframe WITHOUT `allow-same-origin`,
 * so its origin is opaque ("null"). A strict CSP is embedded to defence-in-depth
 * even in the extreme case something slips past DOMPurify.
 *
 * Only the internal measurement script (bound by a per-render nonce) is
 * allowed to run. It posts height updates back to the parent using an
 * exact parent origin plus a per-render channelId.
 */

import DOMPurify from "dompurify";

// ---- CSS hardening ---------------------------------------------------------

// Remove @import rules (they always fetch a remote sheet).
const IMPORT_RE = /@import[^;]*;?/gi;

// Match `url(...)` inside CSS. We allow only `data:` (inline images stitched
// by the bridge) — everything else is neutralised to `none`.
const URL_RE = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;

function sanitizeCssText(css: string): string {
  if (!css) return "";
  let out = css.replace(IMPORT_RE, "");
  out = out.replace(URL_RE, (_m, _q, ref: string) => {
    const v = String(ref || "").trim().toLowerCase();
    if (v.startsWith("data:")) return `url(${ref})`;
    // Block http(s):, blob:, filesystem:, javascript:, //cdn, /path, etc.
    return "none";
  });
  return out;
}

/**
 * Sanitize incoming email HTML with DOMPurify, then walk the DOM to strip
 * remote CSS `url(...)` references from `<style>` bodies and inline `style`
 * attributes. Also rewrites anchor targets/rel and drops non-http(s)/mailto/tel
 * hrefs to protect the user from `javascript:` / `data:` links.
 */
export function sanitizeAndHardenEmailHtml(html: string): string {
  if (!html) return "";

  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base"],
    FORBID_ATTR: ["srcdoc", "formaction"],
    ALLOW_DATA_ATTR: false,
  });

  // Parse in a detached document so we don't touch the app DOM.
  const doc =
    typeof DOMParser !== "undefined"
      ? new DOMParser().parseFromString(
          `<!doctype html><html><head></head><body>${clean}</body></html>`,
          "text/html",
        )
      : null;

  if (!doc || !doc.body) {
    // Fall back to regex-only if DOMParser isn't around (SSR).
    return clean
      .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, body) => {
        return `<style${attrs}>${sanitizeCssText(body)}</style>`;
      })
      .replace(/\sstyle="([^"]*)"/gi, (_m, css) => ` style="${sanitizeCssText(css)}"`)
      .replace(/\sstyle='([^']*)'/gi, (_m, css) => ` style='${sanitizeCssText(css)}'`);
  }

  // Harden every <style> block.
  doc.querySelectorAll("style").forEach((el) => {
    el.textContent = sanitizeCssText(el.textContent || "");
  });

  // Harden every inline style="…" attribute.
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const raw = el.getAttribute("style") || "";
    el.setAttribute("style", sanitizeCssText(raw));
  });

  // Harden anchors: only allow http(s), mailto, tel; force safe target/rel.
  doc.querySelectorAll("a").forEach((el) => {
    const href = (el.getAttribute("href") || "").trim();
    const scheme = href.toLowerCase().split(":")[0];
    const safe =
      href === "" ||
      href.startsWith("#") ||
      scheme === "http" ||
      scheme === "https" ||
      scheme === "mailto" ||
      scheme === "tel";
    if (!safe) el.removeAttribute("href");
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer nofollow");
  });

  return doc.body.innerHTML;
}

// ---- srcDoc / CSP ---------------------------------------------------------

export interface BuildSrcDocOptions {
  html: string;
  nonce: string;
  channelId: string;
  parentOrigin: string;
}

function jsonSafe(value: string): string {
  // JSON.stringify escapes </ so it can't break out of a <script> tag.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildEmailSrcDoc({
  html,
  nonce,
  channelId,
  parentOrigin,
}: BuildSrcDocOptions): string {
  // CSP: opaque-origin iframe. Only inline styles are permitted (emails ship
  // them by design). Scripts require our per-render nonce, so the sandboxed
  // document can execute only the trusted measurement script below.
  const csp = [
    "default-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const measureScript = `
    (function(){
      var origin=${jsonSafe(parentOrigin)};
      var channel=${jsonSafe(channelId)};
      var last=0;
      function send(){
        try{
          var b=document.body, d=document.documentElement;
          var h=Math.max(
            b?b.scrollHeight:0, b?b.offsetHeight:0,
            d?d.scrollHeight:0, d?d.offsetHeight:0
          );
          if(h && Math.abs(h-last)>1){
            last=h;
            parent.postMessage({__mm:'h', channel:channel, h:h}, origin);
          }
        }catch(e){}
      }
      if(document.readyState==='complete') send();
      else window.addEventListener('load', send);
      window.addEventListener('DOMContentLoaded', send);
      Array.prototype.forEach.call(document.images||[], function(img){
        if(!img.complete){ img.addEventListener('load', send); img.addEventListener('error', send); }
      });
      try{
        if(window.ResizeObserver){
          var ro=new ResizeObserver(send);
          ro.observe(document.documentElement);
          if(document.body) ro.observe(document.body);
        }
      }catch(e){}
    })();
  `;

  const baseCss = `
    html,body{margin:0;padding:0;background:transparent;color:#111;
      font-family:'IBM Plex Sans Arabic',system-ui,-apple-system,Segoe UI,sans-serif;
      font-size:14px;line-height:1.6;word-wrap:break-word;overflow-wrap:anywhere;
      overflow:hidden;}
    img,video{max-width:100%;height:auto;border-radius:6px;}
    table{max-width:100%;}
    a{color:#2563eb;}
    blockquote{border-inline-start:3px solid #e5e7eb;margin:8px 0;padding:4px 12px;color:#4b5563;}
    pre,code{white-space:pre-wrap;word-break:break-word;}
  `;

  return (
    `<!doctype html><html><head>` +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<style>${baseCss}</style>` +
    `</head><body>${html}` +
    `<script nonce="${nonce}">${measureScript}<\/script>` +
    `</body></html>`
  );
}

// ---- Message validation ---------------------------------------------------

export interface HeightMessage {
  __mm: "h";
  channel: string;
  h: number;
}

/**
 * True iff the message payload is a well-formed height report for the given
 * channelId. The event.origin / event.source checks live in the React hook
 * because they need runtime references to the iframe and window.
 */
export function isValidHeightPayload(data: unknown, channelId: string): data is HeightMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.__mm !== "h") return false;
  if (d.channel !== channelId) return false;
  const h = Number(d.h);
  return Number.isFinite(h) && h > 0 && h < 100000;
}

// ---- Nonce / channel id ---------------------------------------------------

export function randomToken(bytes = 16): string {
  // Prefer crypto.getRandomValues; fall back to Math.random for SSR/tests.
  try {
    const g = (globalThis as { crypto?: Crypto }).crypto;
    if (g && typeof g.getRandomValues === "function") {
      const arr = new Uint8Array(bytes);
      g.getRandomValues(arr);
      return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* ignore */
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
