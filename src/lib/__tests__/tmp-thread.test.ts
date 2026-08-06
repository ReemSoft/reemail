import { describe, it, expect } from "vitest";
import { splitThreadSegments } from "@/lib/mail-thread-split";
const nested = `<div>Reply 3</div><div class="gmail_quote">On Mon, Ali wrote:<blockquote class="gmail_quote"><div>Reply 2</div><div class="gmail_quote">On Sun, Sara wrote:<blockquote class="gmail_quote"><div>Original 1</div></blockquote></div></blockquote></div>`;
describe("nested", () => {
  it("peels every turn", () => {
    const s = splitThreadSegments(nested);
    console.log(JSON.stringify(s, null, 1));
    expect(s.length).toBe(3);
    expect(s[0]).toContain("Reply 3");
    expect(s[1]).toContain("Reply 2");
    expect(s[2]).toContain("Original 1");
  });
  it("plain message stays one", () => {
    expect(splitThreadSegments("<p>hi</p>").length).toBe(1);
  });
});
