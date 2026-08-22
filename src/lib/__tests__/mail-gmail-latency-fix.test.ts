// Gmail latency surgical fix — architecture guards.
//
// Locks the three message-open bottlenecks:
//   1. the interactive lane is reserved for explicit user actions only
//   2. speculative prefetch (hover/adjacent/visible window) always runs on
//      the background lane and never downloads deferred CID bytes
//   3. a user click never awaits, reuses, or queues behind a speculative
//      background inflight promise
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");

function fetchMessageBlock(): string {
  const start = source.indexOf("const existing = inflight.current.get(requestKey);");
  const end = source.indexOf("inflight.current.set(requestKey, { promise: p, controller, lane });");
  if (start < 0 || end < 0) throw new Error("fetchMessage inflight block not found");
  return source.slice(start, end);
}

describe("MAILMAESTRO_GMAIL_LATENCY_FIX", () => {
  it("an interactive click never awaits a speculative background inflight", () => {
    const block = fetchMessageBlock();
    expect(block).toContain('existing.lane === "background" && lane === "interactive"');
    expect(block).toContain("inflight.current.delete(requestKey);");
    expect(block).not.toContain("const prefetched = await existing.promise;");
    expect(block).not.toContain("prefetch-retry");
  });

  it("keeps identity-checked inflight cleanup so stale flights are never deleted", () => {
    expect(source).toContain("inflight.current.get(requestKey)?.promise === p");
  });

  it("speculative adjacent prefetch runs on the background lane", () => {
    expect(source).toContain('void prefetchMessage(m.id, "adjacent", false, "background");');
    const immediate = source.slice(
      source.indexOf("onImmediatePrefetch={"),
      source.indexOf("onImmediatePrefetch={") + 400,
    );
    expect(immediate).not.toContain('"interactive"');
  });

  it("hover prefetch stays background and never fetches CID bytes", () => {
    expect(source).toContain('void prefetchMessage(id, "hover");');
    expect(source).toContain('lane: "interactive" | "background" = "background",');
    expect(source).toContain("if (withCid) prefetchCidWantedRef.current.add(scopeKey);");
  });

  it("the visible-window prefetch is exactly one bounded Server Function call", () => {
    const start = source.indexOf("const prefetchWindow = useCallback");
    const end = source.indexOf("useCompanyTheme(", start);
    const visible = source.slice(start, end);
    expect(visible).toContain("prefetchWindowFn({");
    expect(visible).toContain("candidates.map");
    expect(visible).not.toContain("candidates.forEach((candidate) => openMsg");
  });

  it("explicit historical message opens stay on the interactive lane", () => {
    const historicalCall = source.slice(
      source.indexOf('fetchMessage(base.id, "interactive", undefined, {'),
      source.indexOf('fetchMessage(base.id, "interactive", undefined, {') + 160,
    );
    expect(historicalCall).toContain('kind: "historical"');
  });

  it("only the interactive viewer persists resolved CID bytes", () => {
    const viewer = source.slice(
      source.indexOf("function useInlineImageMappings"),
      source.indexOf("/** Body renderer"),
    );
    expect(viewer).toContain("persist: true");
    const background = source.slice(
      source.indexOf("const prefetchCidForMessage"),
      source.indexOf("const prefetchMessage"),
    );
    expect(background).toContain("persist: false");
  });
});
