import { describe, expect, it } from "vitest";
import { splitThreadSegments } from "@/lib/mail-thread-split";

const nested = `<div>Reply 3</div><div class="gmail_quote">On Mon, Ali wrote:<blockquote class="gmail_quote"><div>Reply 2</div><div class="gmail_quote">On Sun, Sara wrote:<blockquote class="gmail_quote"><div>Original 1</div></blockquote></div></blockquote></div>`;

describe("splitThreadSegments", () => {
  it("peels every nested turn into its own segment", () => {
    const s = splitThreadSegments(nested);
    expect(s).toHaveLength(3);
    expect(s[0]).toContain("Reply 3");
    expect(s[1]).toContain("Reply 2");
    expect(s[1]).toContain("Ali wrote:");
    expect(s[2]).toContain("Original 1");
    expect(s[0]).not.toContain("Reply 2");
    expect(s[1]).not.toContain("Original 1");
  });

  it("keeps a plain message as a single segment", () => {
    expect(splitThreadSegments("<p>hello</p>")).toEqual(["<p>hello</p>"]);
  });

  it("handles a flat single quote", () => {
    const s = splitThreadSegments("<p>new</p><blockquote><p>old</p></blockquote>");
    expect(s).toHaveLength(2);
    expect(s[0]).toContain("new");
    expect(s[1]).toContain("old");
  });

  it("handles plain-text style chains without blockquotes", () => {
    const s = splitThreadSegments(
      "<div>c</div><div>On Jan 2, Ali wrote:</div><div>b</div><div>On Jan 1, Sara wrote:</div><div>a</div>",
    );
    expect(s).toHaveLength(3);
    expect(s[2]).toContain("Sara wrote:");
    expect(s[2]).toContain(">a<");
  });

  it("never loses content and always returns at least one segment", () => {
    expect(splitThreadSegments("")).toEqual([""]);
    const s = splitThreadSegments(nested);
    for (const seg of s) expect(seg.trim().length).toBeGreaterThan(0);
  });

  it("terminates on pathological nesting", () => {
    const deep = Array.from({ length: 40 })
      .map((_, i) => `<blockquote><div>turn ${i}</div>`)
      .join("");
    const s = splitThreadSegments(deep);
    expect(s.length).toBeLessThanOrEqual(13);
  });
});
