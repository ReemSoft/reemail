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
    const v = String(ref || "")
      .trim()
      .toLowerCase();
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
    // Treat the input as body-fragment content so <style> blocks that ship
    // in real-world newsletters survive sanitization (DOMPurify otherwise
    // drops <style> at the document root).
    FORCE_BODY: true,
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
  messageIdentity?: string;
  generation?: string;
  parentOrigin: string;
  /**
   * When true, allow HTTPS image sources (only). Default is false: only
   * `data:` and `blob:` are allowed. HTTP is never allowed regardless of
   * this flag — mixed-content and cleartext trackers are always blocked.
   */
  allowRemoteImages?: boolean;
}

function jsonSafe(value: string): string {
  // JSON.stringify escapes </ so it can't break out of a <script> tag.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const INLINE_IMAGE_DATA_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export interface CidDataImageMapping {
  cid: string;
  dataUri: string;
  width?: number;
  height?: number;
}

export interface CidBlobImageMapping {
  cid: string;
  blobUrl: string;
  width?: number;
  height?: number;
}

export type CidImageMapping = CidDataImageMapping | CidBlobImageMapping;

export interface CidApplyMessage {
  __mm: "cid";
  channel: string;
  messageIdentity: string;
  generation: string;
  images: CidImageMapping[];
}

export function isAllowedInlineImageDataUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 350_000 || !INLINE_IMAGE_DATA_RE.test(value)) {
    return false;
  }
  const base64 = value.slice(value.indexOf(",") + 1).replace(/\s/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding <= 256 * 1024;
}

/** Blob capabilities are created by the authenticated parent stream path only. */
export function isAllowedInlineImageBlobUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 5 &&
    value.length <= 2048 &&
    /^blob:(?:https?:\/\/[^/\s]+|null)\/[^\s<>"']+$/.test(value)
  );
}

export function isValidCidApplyPayload(
  data: unknown,
  channelId: string,
  messageIdentity = "",
  generation = "",
): data is CidApplyMessage {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  if (
    value.__mm !== "cid" ||
    value.channel !== channelId ||
    value.messageIdentity !== messageIdentity ||
    value.generation !== generation ||
    !Array.isArray(value.images)
  ) {
    return false;
  }
  if (value.images.length > 20) return false;
  let totalBytes = 0;
  const valid = value.images.every((item) => {
    if (!item || typeof item !== "object") return false;
    const image = item as Record<string, unknown>;
    const dimensionsValid =
      (image.width === undefined && image.height === undefined) ||
      (Number.isInteger(image.width) &&
        Number.isInteger(image.height) &&
        Number(image.width) > 0 &&
        Number(image.height) > 0 &&
        Number(image.width) <= 20_000 &&
        Number(image.height) <= 20_000);
    const dataValid = isAllowedInlineImageDataUri(image.dataUri);
    const blobValid = isAllowedInlineImageBlobUrl(image.blobUrl);
    if (
      dimensionsValid &&
      typeof image.cid === "string" &&
      image.cid.length > 0 &&
      image.cid.length <= 998 &&
      dataValid !== blobValid
    ) {
      if (dataValid) {
        const dataUri = image.dataUri as string;
        const base64 = dataUri.slice(dataUri.indexOf(",") + 1).replace(/\s/g, "");
        const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
        totalBytes += Math.floor((base64.length * 3) / 4) - padding;
      }
      return totalBytes <= 1024 * 1024;
    }
    return false;
  });
  return valid;
}

/**
 * Converts CID image sources into inert placeholders before srcDoc creation.
 * The original dimensions remain intact; images without dimensions receive a
 * bounded reserved box from the iframe CSS. No `cid:` navigation is attempted.
 */
export function preparePendingCidImages(html: string): string {
  if (!html || !/<img\b/i.test(html) || !/\bsrc\s*=\s*(["']?)cid:/i.test(html)) return html;
  if (typeof DOMParser === "undefined") {
    return html.replace(
      /(<img\b[^>]*?)\s+src\s*=\s*(["'])cid:([^"']+)\2([^>]*>)/gi,
      (_match, before, _quote, cid, after) =>
        `${before} data-mm-cid="${String(cid).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"${after}`,
    );
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    const src = (image.getAttribute("src") || "").trim();
    if (!src.toLowerCase().startsWith("cid:")) return;
    const cid = src.slice(4).trim().replace(/^<|>$/g, "");
    if (!cid || cid.length > 998) {
      image.removeAttribute("src");
      return;
    }
    image.removeAttribute("src");
    image.setAttribute("data-mm-cid", cid);
    image.setAttribute("aria-busy", "true");
    const width = Number(image.getAttribute("width"));
    const height = Number(image.getAttribute("height"));
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      if (width <= 1 && height <= 1) image.setAttribute("data-mm-tracking", "true");
      else image.style.aspectRatio = `${width} / ${height}`;
    }
  });
  return doc.body.innerHTML;
}

/**
 * Detects whether the (already sanitized) HTML contains any remote image
 * references that the default CSP would block. Used by the viewer to decide
 * whether to show the "external images blocked" banner.
 */
export function hasRemoteImages(html: string): boolean {
  if (!html) return false;
  // <img src="http(s)://..."> or protocol-relative //host/...
  return /<img\b[^>]*\bsrc\s*=\s*(['"])\s*(https?:|\/\/)/i.test(html);
}

export function buildEmailSrcDoc({
  html,
  nonce,
  channelId,
  messageIdentity = "",
  generation = "",
  parentOrigin,
  allowRemoteImages = false,
}: BuildSrcDocOptions): string {
  const stableHtml = preparePendingCidImages(html);
  // Privacy-first image policy: block ALL remote images by default (trackers,
  // read receipts, spy pixels). Only inline `data:`/`blob:` render. When the
  // user explicitly opts in for a message, allow `https:` only — `http:` is
  // NEVER allowed (mixed-content + cleartext tracking).
  const imgSrc = allowRemoteImages ? "img-src data: blob: https:" : "img-src data: blob:";

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
    imgSrc,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const measureScript = `
    (function(){
      var origin=${jsonSafe(parentOrigin)};
      var channel=${jsonSafe(channelId)};
      var messageIdentity=${jsonSafe(messageIdentity)};
      var generation=${jsonSafe(generation)};
      var last=0;
      var batching=false;
      var scale=1;
      var fitting=false;
      var fitVw=0;
      var sends=0;
      /**
       * Gmail-style shrink-to-fit: wide fixed-width newsletters (600-800px
       * tables) would otherwise be clipped on phones/tablets because the
       * document is overflow:hidden. Instead of clipping we downscale the
       * whole body so the full message stays visible, exactly like the Gmail
       * mobile app. It only re-runs when the VIEWPORT WIDTH changes, so the
       * height it reports can never feed back into another measurement.
       */
      function fit(force){
        if(fitting) return;
        var b=document.body, d=document.documentElement;
        if(!b||!d) return;
        var vw=d.clientWidth||0;
        if(!vw) return;
        if(!force && vw===fitVw) return;
        fitting=true;
        try{
          fitVw=vw;
          b.style.transform=''; b.style.width=''; b.style.transformOrigin='';
          scale=1;
          var cw=b.scrollWidth||0;
          if(cw>vw+1){
            var s=Math.max(vw/cw, 0.25);
            scale=s;
            b.style.transformOrigin='top left';
            b.style.width=cw+'px';
            b.style.transform='scale('+s+')';
          }
        }catch(e){}
        finally{ fitting=false; }
      }
      function send(force){
        if(batching && !force) return;
        if(sends>200) return;
        try{
          fit(false);
          var b=document.body;
          // Height is derived from the BODY box only. Using documentElement
          // would include the iframe viewport height the parent just set,
          // which creates an endless grow loop.
          var raw=Math.max(b?b.scrollHeight:0, b?b.offsetHeight:0);
          var h=Math.ceil(raw*scale);
          if(h && Math.abs(h-last)>2){
            last=h;
            sends++;
            parent.postMessage({__mm:'h', channel:channel, h:h}, origin);
          }
        }catch(e){}
      }


      if(document.readyState==='complete') send();
      else window.addEventListener('load', send);
      window.addEventListener('DOMContentLoaded', send);
      window.addEventListener('resize', function(){ fit(true); send(true); });
      window.addEventListener('orientationchange', function(){ fit(true); send(true); });
      Array.prototype.forEach.call(document.images||[], function(img){
        if(!img.complete){ img.addEventListener('load', send); img.addEventListener('error', send); }
      });
      function validImageData(value){
        return typeof value==='string' && value.length<=350000 &&
          /^data:image\\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+\\/=\\s]+$/i.test(value);
      }
      function validImageBlob(value){
        return typeof value==='string' && value.length>5 && value.length<=2048 &&
          /^blob:(?:https?:\\/\\/[^\\/\\s]+|null)\\/[^\\s<>"']+$/.test(value);
      }
      window.addEventListener('message', function(event){
        try{
          if(event.source!==parent || event.origin!==origin) return;
          var data=event.data;
          if(!data || data.__mm!=='cid' || data.channel!==channel || data.messageIdentity!==messageIdentity || data.generation!==generation || !Array.isArray(data.images) || data.images.length>20) return;
          var mapping=Object.create(null);
          var total=0;
          for(var i=0;i<data.images.length;i++){
            var item=data.images[i];
            var dataValid=item&&validImageData(item.dataUri), blobValid=item&&validImageBlob(item.blobUrl);
            if(!item || typeof item.cid!=='string' || item.cid.length<1 || item.cid.length>998 || dataValid===blobValid) continue;
            if((item.width!==undefined || item.height!==undefined) &&
              (!Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width<1 || item.height<1 || item.width>20000 || item.height>20000)) continue;
            if(dataValid){
              var encoded=item.dataUri.slice(item.dataUri.indexOf(',')+1).replace(/\\s/g,'');
              total+=Math.floor(encoded.length*3/4)-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
            }
            if(total>1048576) return;
            mapping[item.cid.toLowerCase()]=item;
          }
          batching=true;
          requestAnimationFrame(function(){
            var nodes=document.querySelectorAll('img[data-mm-cid]');
            var waiting=0, finished=false;
            function done(){
              if(finished) return;
              waiting--;
              if(waiting<=0){
                finished=true;
                batching=false;
                requestAnimationFrame(function(){ send(true); });
              }
            }
            for(var n=0;n<nodes.length;n++){
              var img=nodes[n], cid=(img.getAttribute('data-mm-cid')||'').toLowerCase();
              var item=mapping[cid];
              if(!item) continue;
              var src=validImageData(item.dataUri)?item.dataUri:item.blobUrl;
              if(item.width && item.height){
                if(item.width<=1 && item.height<=1){
                  img.style.display='none';
                }else if(!img.hasAttribute('width') && !img.hasAttribute('height')){
                  img.width=item.width;
                  img.height=item.height;
                  img.style.aspectRatio=item.width+' / '+item.height;
                }
              }
              waiting++;
              img.addEventListener('load', done, {once:true});
              img.addEventListener('error', done, {once:true});
              img.src=src;
              img.removeAttribute('data-mm-cid');
              img.removeAttribute('aria-busy');
              img.style.visibility='';
            }
            if(waiting===0){ finished=true; batching=false; send(true); }
          });
        }catch(e){ batching=false; }
      });
      try{
        if(window.ResizeObserver){
          // Observe the BODY only: documentElement tracks the iframe height
          // the parent sets, which would loop forever.
          var ro=new ResizeObserver(function(){ send(false); });
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
    img[data-mm-cid]{visibility:hidden;}
    img[data-mm-cid]:not([width]):not([height]){width:0;height:0;}
    img[data-mm-tracking]{display:none!important;width:0!important;height:0!important;}
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
    `</head><body>${stableHtml}` +
    `<script nonce="${nonce}">${measureScript}</script>` +
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

// ---- Remote image consent (persisted preference) ---------------------------

/**
 * Users kept seeing "no images" on legitimate mail because remote images are
 * blocked per message and the consent was forgotten on every open. Gmail /
 * Outlook solve this with a remembered "always display external images"
 * preference — same model here.
 *
 * Purely client-side: it only widens the iframe CSP `img-src` to `https:`.
 * No extra request, no server work, zero impact on message open latency.
 */
const REMOTE_IMAGES_PREF_KEY = "mm.remoteImages.always";

export function getAlwaysShowRemoteImages(): boolean {
  try {
    return globalThis.localStorage?.getItem(REMOTE_IMAGES_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAlwaysShowRemoteImages(value: boolean): void {
  try {
    if (value) globalThis.localStorage?.setItem(REMOTE_IMAGES_PREF_KEY, "1");
    else globalThis.localStorage?.removeItem(REMOTE_IMAGES_PREF_KEY);
  } catch {
    /* storage unavailable — fall back to per-message consent */
  }
}
