/**
 * @vitest-environment happy-dom
 *
 * Contract tests for the hardened email viewer security helpers.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeAndHardenEmailHtml,
  buildEmailSrcDoc,
  isValidHeightPayload,
  randomToken,
} from "../email-viewer-security";

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

  it("neutralises external url() in <style> to `none`", () => {
    const dirty = `<style>.a{background:url(https://evil/x.png)}</style><div class="a">x</div>`;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).not.toMatch(/https:\/\/evil/);
    expect(out).toMatch(/background:\s*none/i);
  });

  it("neutralises external url() in inline style", () => {
    const dirty = `<div style="background-image:url('https://evil/x.png')">x</div>`;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).not.toMatch(/https:\/\/evil/);
    expect(out).toMatch(/background-image:\s*none/i);
  });

  it("keeps data: url() references (inline images)", () => {
    const dirty = `<img style="content:url(data:image/png;base64,AAAA)">`;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).toMatch(/url\(data:image\/png/);
  });

  it("blocks protocol-relative and blob: url() in CSS", () => {
    const dirty = `<div style="background:url(//evil/x.png)"></div><div style="background:url(blob:https://x)"></div>`;
    const out = sanitizeAndHardenEmailHtml(dirty);
    expect(out).not.toMatch(/evil/);
    expect(out).not.toMatch(/blob:/);
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
    const out = sanitizeAndHardenEmailHtml(
      `<a href="mailto:x@y.z">m</a><a href="tel:+123">t</a>`,
    );
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
    expect(doc).toMatch(/img-src data: blob:/);
    expect(doc).toMatch(/script-src 'nonce-abc123'/);
    expect(doc).not.toMatch(/unsafe-eval/);
    // No wildcard image / connect sources.
    expect(doc).not.toMatch(/img-src[^;]*\*/);
    expect(doc).not.toMatch(/connect-src[^;]*\*/);
  });

  it("nonces the measurement script tag", () => {
    expect(doc).toMatch(/<script nonce="abc123">/);
  });

  it("never uses postMessage with '*' targetOrigin", () => {
    expect(doc).not.toMatch(/postMessage\([^,]+,\s*['"]\*['"]\)/);
    // Must include the exact parent origin string.
    expect(doc).toMatch(/postMessage\([^)]*"https:\/\/app\.example\.com"\)/);
  });

  it("embeds the channelId in the payload", () => {
    expect(doc).toMatch(/channel:\s*"ch-xyz"|channel:channel/);
    expect(doc).toContain(`"ch-xyz"`);
  });

  it("escapes </script> in injected origin/channel", () => {
    const evil = buildEmailSrcDoc({
      html: "",
      nonce: "n",
      channelId: '</script><script>alert(1)</script>',
      parentOrigin: "https://x",
    });
    expect(evil).not.toMatch(/<\/script><script>alert/);
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
