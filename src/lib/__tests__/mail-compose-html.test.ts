import { describe, expect, it } from "vitest";
import {
  buildEmailHtmlDocument,
  htmlToPlainText,
  inferEmailDirection,
  inlineBlockStyles,
} from "@/lib/mail-compose-html";

describe("inlineBlockStyles", () => {
  it("adds spacing styles to paragraphs", () => {
    expect(inlineBlockStyles("<p>hi</p>")).toBe('<p style="margin:0 0 12px">hi</p>');
  });

  it("keeps author styles winning over defaults", () => {
    const out = inlineBlockStyles('<p style="margin:40px 0">hi</p>');
    expect(out).toBe('<p style="margin:0 0 12px;margin:40px 0">hi</p>');
  });

  it("gives lists bullets and indentation", () => {
    const out = inlineBlockStyles("<ul><li>a</li></ul>");
    expect(out).toContain("list-style:disc");
    expect(out).toContain("padding-inline-start:24px");
  });

  it("preserves other attributes", () => {
    const out = inlineBlockStyles('<a href="https://x.dev">x</a>');
    expect(out).toContain('href="https://x.dev"');
    expect(out).toContain("text-decoration:underline");
  });

  it("leaves inline formatting tags untouched", () => {
    expect(inlineBlockStyles("<b>bold</b><i>it</i>")).toBe("<b>bold</b><i>it</i>");
  });

  it("handles self-closing images", () => {
    expect(inlineBlockStyles('<img src="a.png"/>')).toBe(
      '<img src="a.png" style="max-width:100%;height:auto"/>',
    );
  });

  it("does not impose Composer defaults on preserved source-message layout", () => {
    const out = inlineBlockStyles(
      '<table data-mm-preserve-layout="1" style="border-spacing:7px"><tr data-mm-preserve-layout="1"><td data-mm-preserve-layout="1">x</td></tr></table>',
    );
    expect(out).toContain('style="border-spacing:7px"');
    expect(out).not.toContain("border-collapse:collapse");
    expect(out).not.toContain("padding:4px 8px");
    expect(out).not.toContain("data-mm-preserve-layout");
  });
});

describe("buildEmailHtmlDocument", () => {
  it("returns empty string for empty input", () => {
    expect(buildEmailHtmlDocument("   ")).toBe("");
  });

  it("wraps content with line-height and pre-wrap so spacing survives", () => {
    const out = buildEmailHtmlDocument("<div>a</div>");
    expect(out).toContain("line-height:1.7");
    expect(out).toContain("white-space:pre-wrap");
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("honours ltr direction", () => {
    const out = buildEmailHtmlDocument("<div>a</div>", { dir: "ltr" });
    expect(out).toContain('<html dir="ltr">');
    expect(out).toContain("text-align:left");
  });

  it("defaults to rtl", () => {
    expect(buildEmailHtmlDocument("<div>a</div>")).toContain('<html dir="rtl">');
  });
});

describe("inferEmailDirection", () => {
  it("detects Arabic after ignoring HTML tag names", () => {
    expect(inferEmailDirection("<div><strong>مرحبا بكم</strong></div>")).toBe("rtl");
  });

  it("detects English after ignoring HTML tag names", () => {
    expect(inferEmailDirection("<div><strong>Hello there</strong></div>")).toBe("ltr");
  });
});

describe("htmlToPlainText", () => {
  it("keeps line breaks", () => {
    expect(htmlToPlainText("<div>a</div><div>b</div>")).toBe("a\nb");
  });

  it("converts br tags", () => {
    expect(htmlToPlainText("a<br>b")).toBe("a\nb");
  });

  it("decodes basic entities", () => {
    expect(htmlToPlainText("<p>a &amp; b&nbsp;c</p>")).toBe("a & b c");
  });
});
