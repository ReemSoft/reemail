/**
 * @vitest-environment jsdom
 *
 * Contract tests for the hardened email viewer security helpers.
 */
// @ts-expect-error jsdom is provided by the test runtime without bundled declarations.
import { JSDOM } from "jsdom";
import { describe, it, expect, vi } from "vitest";
import {
  sanitizeAndHardenEmailHtml,
  buildEmailSrcDoc,
  isValidHeightPayload,
  randomToken,
  hasRemoteImages,
  preparePendingCidImages,
  isAllowedInlineImageDataUri,
  isValidCidApplyPayload,
  isValidLargeCidApplyPayload,
} from "../email-viewer-security";

// Extract the img-src directive from a built srcDoc's CSP meta.
function extractImgSrc(doc: string): string {
  const m = doc.match(/Content-Security-Policy"\s+content="([^"]+)"/);
  if (!m) throw new Error("CSP meta not found");
  const csp = m[1];
  const dir = csp
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("img-src "));
  if (!dir) throw new Error("img-src directive missing");
  return dir;
}

describe("sanitizeAndHardenEmailHtml — dangerous tags/attrs", () => {
  it("strips <script>, on* handlers, javascript: hrefs", () => {
    const dirty = `
      <p onclick="alert(1)">hi</p>
      <script>alert('x')</script>
      <a href="javascript:alert(1)">x</a>
      <img src="x" onerror="alert(1)">
    `;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onerror=/i);
    expect(out).not.toMatch(/onclick=/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  it("strips iframe / object / embed / form / base / meta / link", () => {
    const dirty = `
      <iframe src="https://evil"></iframe>
      <object data="x"></object>
      <embed src="x">
      <form action="https://evil"></form>
      <base href="https://evil">
      <meta http-equiv="refresh" content="0;url=https://evil">
      <link rel="stylesheet" href="https://evil/x.css">
    `;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/<object/i);
    expect(out).not.toMatch(/<embed/i);
    expect(out).not.toMatch(/<form/i);
    expect(out).not.toMatch(/<base/i);
    expect(out).not.toMatch(/<meta/i);
    expect(out).not.toMatch(/<link/i);
  });
});

describe("sanitizeAndHardenEmailHtml — CSS hardening", () => {
  it("removes @import rules", () => {
    const dirty = `<style>@import url("https://evil/x.css"); p{color:red}</style><p>hi</p>`;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).not.toMatch(/@import/i);
    expect(out).toMatch(/color:\s*red/i);
  });

  it("preserves HTTPS image url() in <style>", () => {
    const dirty = '<style>.a{background:url(https://cdn.example/x.png)}</style><div class="a">x</div>';
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).toContain("https://cdn.example/x.png");
    expect(out).not.toContain("background: none");
  });

  it("preserves HTTPS image url() in inline style", () => {
    const dirty = '<div style="background-image:url(\'https://cdn.example/x.png\')">x</div>';
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).toContain("https://cdn.example/x.png");
    expect(out).not.toContain("background-image: none");
  });

  it("keeps data: url() references (inline images)", () => {
    const dirty = `<img style="content:url(data:image/png;base64,AAAA)">`;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).toMatch(/url\(data:image\/png/);
  });

  it("preserves protocol-relative images but blocks cleartext and unsafe CSS URLs", () => {
    const dirty = '<div style="background:url(//cdn.example/x.png)"></div><div style="background:url(blob:https://x)"></div><div style="background:url(http://legacy.example/x.png)"></div>';
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).toContain("//cdn.example/x.png");
    expect(out).not.toContain("blob:https://x");
    expect(out).not.toContain("http://legacy.example/x.png");
  });
});

describe("sanitizeAndHardenEmailHtml — anchor hardening", () => {
  it("forces target=_blank and rel=noopener noreferrer nofollow", () => {
    const out = sanitizeAndHardenEmailHtml(`<a href="https://x.com">go</a>`);
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/rel="noopener noreferrer nofollow"/);
  });

  it("drops href when scheme is not http(s)/mailto/tel", () => {
    const out = sanitizeAndHardenEmailHtml(
      `<a href="ftp://x">a</a><a href="file:///etc/passwd">b</a>`,
    );
    expect(out).not.toMatch(/href="ftp:/);
    expect(out).not.toMatch(/file:/);
  });

  it("allows mailto: and tel: schemes", () => {
    const out = sanitizeAndHardenEmailHtml(`<a href="mailto:x@y.z">m</a><a href="tel:+123">t</a>`);
    expect(out).toMatch(/href="mailto:x@y.z"/);
    expect(out).toMatch(/href="tel:\+123"/);
  });
});

describe("sanitizeAndHardenEmailHtml — legitimate content preserved", () => {
  it("preserves tables, colours, spacing, and inline safe styles", () => {
    const dirty = `
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="background:#f0f0f0;padding:8px;color:#111">Hello</td></tr>
      </table>
    `;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).toMatch(/<table/i);
    expect(out).toMatch(/background:\s*#f0f0f0/i);
    expect(out).toMatch(/padding:\s*8px/i);
    expect(out).toMatch(/Hello/);
  });
});

describe("buildEmailSrcDoc — CSP + measurement contract", () => {
  const doc = buildEmailSrcDoc({
    html: "<p>hi</p>",
    nonce: "abc123",
    channelId: "ch-xyz",
    parentOrigin: "https://app.example.com",
  });

  it("embeds a strict CSP with a nonce'd script-src", () => {
    expect(doc).toMatch(/Content-Security-Policy/);
    expect(doc).toMatch(/default-src 'none'/);
    expect(doc).toMatch(/object-src 'none'/);
    expect(doc).toMatch(/base-uri 'none'/);
    expect(doc).toMatch(/form-action 'none'/);
    expect(doc).toMatch(/script-src 'nonce-abc123'/);
    expect(doc).not.toMatch(/unsafe-eval/);
    // No wildcard image / connect sources.
    expect(doc).not.toMatch(/img-src[^;]*\*/);
    expect(doc).not.toMatch(/connect-src[^;]*\*/);
  });

  it("default img-src blocks all remote images (only data:/blob:)", () => {
    const dir = extractImgSrc(doc);
    expect(dir).toBe("img-src data: blob:");
    // Strict: no remote schemes appear anywhere in the directive.
    expect(dir).not.toMatch(/\bhttps?:/);
    expect(dir).not.toMatch(/\*/);
  });

  it("nonces the measurement script tag", () => {
    expect(doc).toMatch(/<script nonce="abc123">/);
  });

  it("does not impose generic image, table, link, blockquote or code styles on source mail", () => {
    expect(doc).not.toContain("img,video{");
    expect(doc).not.toContain("table{max-width");
    expect(doc).not.toContain("a{color:");
    expect(doc).not.toContain("blockquote{border");
    expect(doc).not.toContain("pre,code{");
  });

  it("never uses postMessage with '*' targetOrigin", () => {
    expect(doc).not.toMatch(/postMessage\([^,]+,\s*['"]\*['"]\)/);
    // Parent origin must be baked in — script uses `parent.postMessage(..., origin)`
    // and `var origin = "https://app.example.com"` at the top of the measurement IIFE.
    expect(doc).toMatch(/var\s+origin\s*=\s*"https:\/\/app\.example\.com"/);
    expect(doc).toMatch(/postMessage\([^)]*,\s*origin\)/);
  });

  it("embeds the channelId in the payload", () => {
    expect(doc).toMatch(/channel:\s*"ch-xyz"|channel:channel/);
    expect(doc).toContain(`"ch-xyz"`);
  });

  it("escapes </script> in injected origin/channel", () => {
    const evil = buildEmailSrcDoc({
      html: "",
      nonce: "n",
      channelId: "</script><script>alert(1)</script>",
      parentOrigin: "https://x",
    });
    expect(evil).not.toMatch(/<\/script><script>alert/);
  });
});

describe("MAILMAESTRO_INSTANT_NAVIGATION_R1 stable CID iframe", () => {
  it("creates an inert CID placeholder while preserving dimensions", () => {
    const out = preparePendingCidImages(`<img src="cid:logo" width="120" height="40">`);
    expect(out).toContain(`data-mm-cid="logo"`);
    expect(out).toContain(`width="120"`);
    expect(out).toContain(`height="40"`);
    expect(out).not.toContain(`src="cid:`);
  });

  it("normalizes URL-encoded CID placeholders without moving the image node", () => {
    const out = preparePendingCidImages(
      `<table><tbody><tr><td><img src="cid:photo%40example.com"></td></tr></tbody></table>`,
    );
    const template = document.createElement("template");
    template.innerHTML = out;
    const cell = template.content.querySelector("td");
    const image = template.content.querySelector("img");
    expect(image?.getAttribute("data-mm-cid")).toBe("photo@example.com");
    expect(cell?.firstElementChild).toBe(image);
  });

  it("keeps srcDoc stable before and after CID bytes become available", () => {
    const options = {
      html: `<p>hello</p><img src="cid:logo">`,
      nonce: "n",
      channelId: "channel",
      parentOrigin: "https://app.example.com",
    };
    const before = buildEmailSrcDoc(options);
    const after = buildEmailSrcDoc(options);
    expect(after).toBe(before);
    expect(before).toContain("requestAnimationFrame");
    expect(before).toContain("querySelectorAll('img[data-mm-cid]')");
  });

  it("accepts only the matching channel and safe raster image MIME", () => {
    const valid = {
      __mm: "cid",
      channel: "channel",
      messageIdentity: "message",
      generation: "generation",
      images: [{ cid: "logo", dataUri: "data:image/png;base64,AAAA" }],
    };
    expect(isValidCidApplyPayload(valid, "channel", "message", "generation")).toBe(true);
    expect(isValidCidApplyPayload(valid, "other", "message", "generation")).toBe(false);
    expect(isValidCidApplyPayload(valid, "channel", "other", "generation")).toBe(false);
    expect(isValidCidApplyPayload(valid, "channel", "message", "old")).toBe(false);
    expect(isAllowedInlineImageDataUri("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isAllowedInlineImageDataUri("data:text/html;base64,AAAA")).toBe(false);
  });

  it("accepts only bounded raster ArrayBuffer payloads for large CID", () => {
    const large = {
      __mm: "cid-large",
      channel: "channel",
      messageIdentity: "message",
      generation: "generation",
      images: [{ cid: "large", mimeType: "image/png", bytes: new ArrayBuffer(1024) }],
    };
    expect(isValidLargeCidApplyPayload(large, "channel", "message", "generation")).toBe(true);
    expect(
      isValidLargeCidApplyPayload(
        {
          ...large,
          images: [{ cid: "large", mimeType: "image/svg+xml", bytes: new ArrayBuffer(1) }],
        },
        "channel",
        "message",
        "generation",
      ),
    ).toBe(false);
    expect(
      isValidLargeCidApplyPayload(
        {
          ...large,
          images: [
            {
              cid: "large",
              mimeType: "image/png",
              bytes: new ArrayBuffer(25 * 1024 * 1024 + 1),
            },
          ],
        },
        "channel",
        "message",
        "generation",
      ),
    ).toBe(false);
    const doc = buildEmailSrcDoc({
      html: `<img src="cid:large">`,
      nonce: "n",
      channelId: "channel",
      messageIdentity: "message",
      generation: "generation",
      parentOrigin: "https://app.example.com",
    });
    expect(doc).toContain("new Blob([item.bytes]");
    expect(doc).toContain("URL.createObjectURL(blob)");
    expect(doc).not.toContain("item.blobUrl");
  });

  it("creates the Blob URL inside the iframe and reveals only after load", async () => {
    const createObjectURL = vi.fn((_blob: unknown) => "blob:null/iframe-local");
    const revokeObjectURL = vi.fn();
    const doc = buildEmailSrcDoc({
      html: `<p>Thanks and regards</p><img alt="ChatGPT Image" src="cid:mm-inline-large@mailmaestro">`,
      nonce: "n",
      channelId: "channel",
      messageIdentity: "inbox:42",
      generation: "g1",
      parentOrigin: "https://app.example.com",
    });
    const runtime = new JSDOM(doc, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "https://app.example.com",
      beforeParse(window: Window & typeof globalThis) {
        window.URL.createObjectURL = createObjectURL;
        window.URL.revokeObjectURL = revokeObjectURL;
      },
    });
    const { window } = runtime;
    const bytes = new window.ArrayBuffer(Math.round(1.8 * 1024 * 1024));
    window.dispatchEvent(
      new window.MessageEvent("message", {
        origin: "https://app.example.com",
        source: window,
        data: {
          __mm: "cid-large",
          channel: "channel",
          messageIdentity: "inbox:42",
          generation: "g1",
          images: [{ cid: "mm-inline-large@mailmaestro", mimeType: "image/png", bytes }],
        },
      }),
    );
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const image = window.document.querySelector("img") as HTMLImageElement;
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(window.Blob);
    expect(image.src).toBe("blob:null/iframe-local");
    expect(image.hasAttribute("data-mm-cid")).toBe(true);
    expect(image.style.visibility).toBe("hidden");

    image.dispatchEvent(new window.Event("load"));
    expect(image.hasAttribute("data-mm-cid")).toBe(false);
    expect(image.hasAttribute("aria-busy")).toBe(false);
    expect(image.style.visibility).toBe("");
    expect(revokeObjectURL).not.toHaveBeenCalled();
    runtime.window.close();
  });

  it("keeps a failed large CID hidden and removes its broken src", async () => {
    const revokeObjectURL = vi.fn();
    const doc = buildEmailSrcDoc({
      html: `<img src="cid:large">`,
      nonce: "n",
      channelId: "channel",
      messageIdentity: "inbox:42",
      generation: "g1",
      parentOrigin: "https://app.example.com",
    });
    const runtime = new JSDOM(doc, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "https://app.example.com",
      beforeParse(window: Window & typeof globalThis) {
        window.URL.createObjectURL = () => "blob:null/fails";
        window.URL.revokeObjectURL = revokeObjectURL;
      },
    });
    const { window } = runtime;
    window.dispatchEvent(
      new window.MessageEvent("message", {
        origin: "https://app.example.com",
        source: window,
        data: {
          __mm: "cid-large",
          channel: "channel",
          messageIdentity: "inbox:42",
          generation: "g1",
          images: [{ cid: "large", mimeType: "image/png", bytes: new window.ArrayBuffer(64) }],
        },
      }),
    );
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const image = window.document.querySelector("img") as HTMLImageElement;
    image.dispatchEvent(new window.Event("error"));
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.style.visibility).toBe("hidden");
    expect(image.getAttribute("data-mm-cid-failed")).toBe("1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:null/fails");
    runtime.window.close();
  });

  it("enforces 256KB per image and 1MB total postMessage limits", () => {
    const tooLarge = `data:image/png;base64,${"A".repeat(350_000)}`;
    expect(isAllowedInlineImageDataUri(tooLarge)).toBe(false);
    const nearLimit = `data:image/png;base64,${"A".repeat(340_000)}`;
    expect(
      isValidCidApplyPayload(
        {
          __mm: "cid",
          channel: "channel",
          messageIdentity: "",
          generation: "",
          images: Array.from({ length: 5 }, (_, index) => ({
            cid: String(index),
            dataUri: nearLimit,
          })),
        },
        "channel",
      ),
    ).toBe(false);
  });

  it("checks parent source/origin and batches all CID DOM writes in one frame", () => {
    const doc = buildEmailSrcDoc({
      html: `<img src="cid:a"><img src="cid:b">`,
      nonce: "n",
      channelId: "channel",
      parentOrigin: "https://app.example.com",
    });
    expect(doc).toContain("event.source!==parent");
    expect(doc).toContain("event.origin!==origin");
    expect(doc.match(/querySelectorAll\('img\[data-mm-cid\]'\)/g)).toHaveLength(2);
  });

  it("does not reserve 320x240 for an image without dimensions", () => {
    const doc = buildEmailSrcDoc({
      html: `<img src="cid:logo">`,
      nonce: "n",
      channelId: "channel",
      parentOrigin: "https://app.example.com",
    });
    expect(doc).not.toContain("320px");
    expect(doc).toContain("img[data-mm-cid]:not([width]):not([height]){width:0;height:0;}");
  });

  it("hides tracking pixels and preserves valid HTML aspect ratios", () => {
    const tracking = preparePendingCidImages(`<img src="cid:track" width="1" height="1">`);
    expect(tracking).toContain('data-mm-tracking="true"');
    const logo = preparePendingCidImages(`<img src="cid:logo" width="120" height="40">`);
    expect(logo).toContain('width="120"');
    expect(logo).toContain('height="40"');
    expect(logo).toMatch(/aspect-ratio:\s*120\s*\/\s*40/i);
  });

  it("applies decoded intrinsic dimensions before exposing the CID src", () => {
    const doc = buildEmailSrcDoc({
      html: `<img src="cid:logo">`,
      nonce: "n",
      channelId: "channel",
      messageIdentity: "inbox:1",
      generation: "g1",
      parentOrigin: "https://app.example.com",
    });
    expect(doc.indexOf("img.width=item.width")).toBeLessThan(doc.indexOf("img.src=src"));
    expect(doc).toContain("data.messageIdentity!==messageIdentity");
    expect(doc).toContain("data.generation!==generation");
  });
});

describe("buildEmailSrcDoc — remote image privacy gate", () => {
  const opts = {
    html: `<img src="https://tracker.example/pixel.gif">`,
    nonce: "n1",
    channelId: "c1",
    parentOrigin: "https://app.example.com",
  };

  it("default srcDoc allows neither https: nor http: images", () => {
    const dir = extractImgSrc(buildEmailSrcDoc(opts));
    expect(dir).toBe("img-src data: blob:");
    expect(dir).not.toMatch(/\bhttps:/);
    expect(dir).not.toMatch(/\bhttp:/);
  });

  it("after explicit consent, allows https: only — http: stays blocked", () => {
    const dir = extractImgSrc(buildEmailSrcDoc({ ...opts, allowRemoteImages: true }));
    expect(dir).toBe("img-src data: blob: https:");
    expect(dir).toMatch(/\bhttps:/);
    // http: never appears as a standalone scheme token in the directive.
    expect(dir.split(/\s+/)).not.toContain("http:");
  });

  it("does not embed remote image URLs into the CSP itself (no allowlist leaks)", () => {
    const doc = buildEmailSrcDoc(opts);
    // The remote host must not appear in CSP or the head — only inside body <img>.
    const head = doc.split("</head>")[0];
    expect(head).not.toMatch(/tracker\.example/);
  });
});

describe("hasRemoteImages", () => {
  it("detects http/https/protocol-relative <img src>", () => {
    expect(hasRemoteImages(`<img src="https://x/y.png">`)).toBe(true);
    expect(hasRemoteImages(`<img src="http://x/y.png">`)).toBe(true);
    expect(hasRemoteImages(`<img src="//x/y.png">`)).toBe(true);
  });

  it("ignores inline (data:/cid:) images and empty input", () => {
    expect(hasRemoteImages(`<img src="data:image/png;base64,AAAA">`)).toBe(false);
    expect(hasRemoteImages(`<img src="cid:abc">`)).toBe(false);
    expect(hasRemoteImages("")).toBe(false);
    expect(hasRemoteImages("<p>no images</p>")).toBe(false);
  });
});

describe("isValidHeightPayload", () => {
  it("accepts a well-formed message with matching channel", () => {
    expect(isValidHeightPayload({ __mm: "h", channel: "c1", h: 400 }, "c1")).toBe(true);
  });

  it("rejects mismatching channels", () => {
    expect(isValidHeightPayload({ __mm: "h", channel: "other", h: 400 }, "c1")).toBe(false);
  });

  it("rejects wrong tag / bad height / non-object", () => {
    expect(isValidHeightPayload({ __mm: "x", channel: "c1", h: 400 }, "c1")).toBe(false);
    expect(isValidHeightPayload({ __mm: "h", channel: "c1", h: 0 }, "c1")).toBe(false);
    expect(isValidHeightPayload({ __mm: "h", channel: "c1", h: -1 }, "c1")).toBe(false);
    expect(isValidHeightPayload({ __mm: "h", channel: "c1", h: 999999 }, "c1")).toBe(false);
    expect(isValidHeightPayload(null, "c1")).toBe(false);
    expect(isValidHeightPayload("nope", "c1")).toBe(false);
  });
});

describe("randomToken", () => {
  it("returns a hex-ish non-empty string, distinct across calls", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a.length).toBeGreaterThan(8);
    expect(a).not.toBe(b);
  });
});
