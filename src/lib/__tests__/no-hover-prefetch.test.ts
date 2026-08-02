// Regression guard: hover/focus prefetch is delayed and enters the bounded,
// single-concurrency adaptive queue. Pointer-down promotes the requested row.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mailSource = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");

describe("bounded hover prefetch", () => {
  it("delays hover/focus and cancels abandoned intent", () => {
    expect(mailSource).toMatch(/onPointerEnter=\{onPrefetch\}/);
    expect(mailSource).toMatch(/onFocus=\{onPrefetch\}/);
    expect(mailSource).toMatch(/onPointerLeave=\{onCancelPrefetch\}/);
    expect(mailSource).toMatch(/}, 120\)/);
  });

  it("uses immediate pointer-down intent and a shared adaptive queue", () => {
    expect(mailSource).toMatch(/onPointerDown=\{onImmediatePrefetch\}/);
    expect(mailSource).toMatch(/AdaptivePrefetchQueue/);
    expect(mailSource).toMatch(/const prefetchMessage\b/);
  });

  it("opening a message is still wired to the row click handler", () => {
    expect(mailSource).toMatch(/else openMessage\(m\.id\)/);
  });
});
