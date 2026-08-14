import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLargeInlineCidSessionCache,
  readLargeInlineCidSessionCache,
  storeLargeInlineCidSessionCache,
  type InlineCidPart,
} from "../mail-inline-cid-policy";

const parts: InlineCidPart[] = Array.from({ length: 5 }, (_, index) => ({
  cid: `image-${index}@example`,
  part: `2.${index + 1}`,
  mimeType: "image/png",
  size: 300 * 1024,
}));

describe("MAILMAESTRO_LIGHTNING_MESSAGE_OPEN", () => {
  beforeEach(() => clearLargeInlineCidSessionCache());

  it("reopens large CID bytes from the bounded physical-session cache", () => {
    const mappings = parts.map((part) => ({
      cid: part.cid,
      mimeType: part.mimeType,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    }));
    storeLargeInlineCidSessionCache("company|account|inbox|42|99", parts, mappings);
    const reopened = readLargeInlineCidSessionCache("company|account|inbox|42|99", parts);
    expect(reopened.misses).toEqual([]);
    expect(reopened.hits).toHaveLength(5);
    expect(readLargeInlineCidSessionCache("company|account|inbox|42|100", parts).hits).toEqual([]);
  });

  it("uses one client batch, one Server Function, and one Bridge endpoint for a window", () => {
    const route = readFileSync("src/routes/mail.tsx", "utf8");
    const server = readFileSync("src/lib/mail-message-open.functions.ts", "utf8");
    const bridge = readFileSync("bridge/src/index.ts", "utf8");
    const start = route.indexOf("const prefetchWindow = useCallback");
    const visible = route.slice(start, route.indexOf("useCompanyTheme(", start));
    expect(visible).toContain("prefetchWindowFn({");
    expect(visible).toContain("messages: candidates.map");
    expect(visible).not.toContain("candidates.forEach((candidate) => openMsg");
    expect(server).toContain('"/api/messages-prefetch"');
    expect(bridge.match(/app\.post\(\s*"\/api\/messages-prefetch"/g)).toHaveLength(1);
    expect(route).toContain("prefetchWindowFlightRef.current?.controller.abort()");
  });

  it("batches five deferred CIDs through one browser and one Bridge request", () => {
    const route = readFileSync("src/routes/mail.tsx", "utf8");
    const api = readFileSync("src/routes/api/mail-inline-part.ts", "utf8");
    const viewer = route.slice(
      route.indexOf("function useInlineImageMappings"),
      route.indexOf("function MessageBody"),
    );
    expect(viewer).toContain("fetchInlineCidPartsBatch(cached.misses");
    expect(viewer.match(/fetch\("\/api\/mail-inline-part"/g)).toHaveLength(1);
    expect(viewer).toContain("const resolved = [...cached.hits, ...mappings]");
    expect(viewer).toContain("onLargeCid?.(resolved)");
    expect(api).toContain('"/api/message-inline-parts"');
  });

  it("keeps text first, remote images blocked, and one atomic large-CID postMessage", () => {
    const route = readFileSync("src/routes/mail.tsx", "utf8");
    const security = readFileSync("src/lib/email-viewer-security.ts", "utf8");
    expect(route).toContain("if (!largeReady || !messageKey) return");
    expect(route).toContain("setSelectedMessage(base)");
    expect(route).toContain("images.map((image) => image.bytes)");
    expect(security).toContain('"img-src data: blob:"');
    expect(security).toContain("data.images.length>20");
  });
});
