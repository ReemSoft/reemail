// Regression guard: hover/focus/touch prefetch must stay disabled.
//
// Every message download is serialized on the single per-account IMAP
// connection. When rows prefetched on hover, scrolling a list queued dozens of
// downloads ahead of the user's actual click (head-of-line blocking → slow
// opens and "Failed to open message"). Messages are fetched on click only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mailSource = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");

describe("no hover prefetch accumulation", () => {
  it("message rows do not bind prefetch to onMouseEnter / onFocus / onTouchStart", () => {
    expect(mailSource).not.toMatch(/onMouseEnter=\{onPrefetch\}/);
    expect(mailSource).not.toMatch(/onFocus=\{onPrefetch\}/);
    expect(mailSource).not.toMatch(/onTouchStart=\{onPrefetch\}/);
  });

  it("no prefetch callback is passed to the list rows any more", () => {
    expect(mailSource).not.toMatch(/onPrefetch=\{/);
    expect(mailSource).not.toMatch(/const prefetchMessage\b/);
  });

  it("opening a message is still wired to the row click handler", () => {
    expect(mailSource).toMatch(/else openMessage\(m\.id\)/);
  });
});
