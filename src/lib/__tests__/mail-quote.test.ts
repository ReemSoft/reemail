import { describe, expect, it } from "vitest";
import {
  buildForwardQuoteHtml,
  buildReplyQuoteHtml,
  extractBodyFragment,
  toQuotableFragment,
} from "@/lib/mail-quote";
import { splitQuotedHtml } from "@/lib/mail-thread-split";

const meta = { from: { name: "Ali", email: "ali@x.com" }, date: "2026-01-02T10:00:00Z" };

describe("extractBodyFragment", () => {
  it("drops style/script/head/doctype noise", () => {
    const html = `<!DOCTYPE html><html><head><style>#outlook a{padding:0}</style></head><body><p>Hi</p><script>x()</script></body></html>`;
    const out = extractBodyFragment(html);
    expect(out).toBe("<p>Hi</p>");
    expect(out).not.toMatch(/padding:0|outlook|script/i);
  });

  it("removes comments", () => {
    expect(extractBodyFragment("<!--[if mso]>junk<![endif]--><p>a</p>")).toBe("<p>a</p>");
  });
});

describe("toQuotableFragment", () => {
  it("escapes plain text and keeps line breaks", () => {
    expect(toQuotableFragment("a < b\nc")).toBe("a &lt; b<br>c");
  });
});

describe("buildReplyQuoteHtml / buildForwardQuoteHtml", () => {
  it("wraps the original in a blockquote without CSS leakage", () => {
    const out = buildReplyQuoteHtml(
      `<html><head><style>p{color:red}</style></head><body><p>Hello</p></body></html>`,
      meta,
      "en",
    );
    expect(out).toContain("<blockquote");
    expect(out).toContain("<p>Hello</p>");
    expect(out).not.toMatch(/color:red/);
    expect(out).toContain("ali@x.com");
  });

  it("forward includes header rows", () => {
    const out = buildForwardQuoteHtml(
      "<p>body</p>",
      { ...meta, subject: "S", cc: [{ name: "Copy", email: "copy@example.com" }] },
      "en",
    );
    expect(out).toContain("Forwarded message");
    expect(out).toContain("Subject:");
    expect(out).toContain("Cc:");
    expect(out).toContain("copy@example.com");
    expect(out).toContain("<p>body</p>");
  });

  it.each([
    ["reply in Arabic UI with English source", buildReplyQuoteHtml, "Hello from London", "ar"],
    ["reply all in Arabic UI with English source", buildReplyQuoteHtml, "Hello from London", "ar"],
    ["forward in Arabic UI with English source", buildForwardQuoteHtml, "Hello from London", "ar"],
    ["reply in English UI with Arabic source", buildReplyQuoteHtml, "مرحبا من الرياض", "en"],
    ["forward in English UI with Arabic source", buildForwardQuoteHtml, "مرحبا من الرياض", "en"],
  ])("isolates %s with native automatic direction", (_name, build, body, locale) => {
    const out = build(body, meta, locale);
    expect(out).toContain('data-mm-quoted-content="1" dir="auto"');
    expect(out).toContain("padding-inline-start:12px");
    expect(out).toContain("border-inline-start:2px");
    expect(out).toContain("text-align:start");
  });

  it("isolates mixed-direction attribution and forward values", () => {
    const mixedMeta = {
      ...meta,
      from: { name: "علي Ali", email: "ali@example.com" },
      to: [{ name: "Sara سارة", email: "sara@example.com" }],
      subject: "Project مشروع",
    };
    const reply = buildReplyQuoteHtml("Hello", mixedMeta, "ar", "كتب:");
    const forward = buildForwardQuoteHtml("Hello", mixedMeta, "ar");
    expect(reply).toContain("<bdi>علي Ali &lt;ali@example.com&gt;</bdi>");
    expect(forward).toContain("<bdi>Project مشروع</bdi>");
    expect(forward).toContain("<bdi>Sara سارة &lt;sara@example.com&gt;</bdi>");
  });

  it.each([
    ["Arabic reply", buildReplyQuoteHtml, "ar-SA", "rtl", "right"],
    ["Arabic forward", buildForwardQuoteHtml, "ar", "rtl", "right"],
    ["English reply", buildReplyQuoteHtml, "en-US", "ltr", "left"],
    ["English forward", buildForwardQuoteHtml, "en", "ltr", "left"],
  ])("aligns every system-generated %s block with the UI language", (_name, build, locale, dir, align) => {
    const out = build("مرحبا Hello", meta, locale);
    expect(out).toContain(`class="mm_quote" dir="${dir}" style="direction:${dir};text-align:${align}"`);
    expect(out).toContain(`dir="${dir}" style="color:`);
    expect(out).toContain(`direction:${dir};text-align:${align}`);
    expect(out).toContain('data-mm-quoted-content="1" dir="auto"');
  });
});

describe("splitQuotedHtml", () => {
  it("splits on blockquote", () => {
    const r = splitQuotedHtml("<p>new</p><blockquote><p>old</p></blockquote>");
    expect(r.latest).toBe("<p>new</p>");
    expect(r.quoted).toContain("old");
  });

  it("splits on 'On ... wrote:'", () => {
    const r = splitQuotedHtml("<div>reply</div><div>On Jan 1, Ali wrote:</div><div>old</div>");
    expect(r.latest).toContain("reply");
    expect(r.quoted).toContain("Ali wrote:");
  });

  it("returns the whole Mail Maestro mm_quote wrapper in quoted", () => {
    const html =
      '<div>رد جديد</div><div><br></div><div class="mm_quote"><div style="color:#71717a;font-size:12px;margin:0 0 8px"><bdi>15/08/2026, 4:45 م</bdi> — <bdi>Hussam Hussam &lt;iamhusam@gmail.com&gt;</bdi> كتب:</div><blockquote style="margin:0;color:#3f3f46"><div data-mm-quoted-content="1" dir="auto" style="padding-inline-start:12px">تم استلام الملف</div></blockquote></div>';
    const r = splitQuotedHtml(html);
    expect(r.latest).toBe("<div>رد جديد</div><div><br></div>");
    expect(r.quoted.startsWith('<div class="mm_quote">')).toBe(true);
    expect(r.quoted).toContain("كتب:");
    expect(r.quoted).toContain("تم استلام الملف");
  });

  it("returns no quote when the body is entirely a quote", () => {
    const r = splitQuotedHtml("<blockquote>old</blockquote>");
    expect(r.quoted).toBe("");
  });

  it("returns no quote for a plain message", () => {
    const r = splitQuotedHtml("<p>just a message</p>");
    expect(r.quoted).toBe("");
    expect(r.latest).toBe("<p>just a message</p>");
  });
});
