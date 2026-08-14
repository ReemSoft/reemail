import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  INLINE_CID_FAST_MAX_BYTES,
  INLINE_CID_FAST_TOTAL_BYTES,
  INLINE_CID_STREAM_MAX_BYTES,
  partitionInlineCidParts,
  streamInlineCidPartsSequential,
  type InlineCidPart,
} from "../mail-inline-cid-policy";

function part(cid: string, size: number, mimeType = "image/png"): InlineCidPart {
  return { cid, part: String(cid.length + 1), mimeType, size };
}

describe("large inline CID receive policy", () => {
  it("keeps a 1.8 MiB referenced CID out of the 256 KiB resolver", () => {
    const large = part("mm-inline-large@mailmaestro", Math.round(1.8 * 1024 * 1024));
    const result = partitionInlineCidParts([large]);
    expect(result.smallBatchParts).toEqual([]);
    expect(result.largeStreamParts).toEqual([large]);
    expect(result.oversizedUnsafeParts).toEqual([]);
  });

  it("partitions a mixed small and large message without duplicating embedded CIDs", () => {
    const small = part("logo-small", 40 * 1024);
    const large = part("photo-large", Math.round(1.8 * 1024 * 1024));
    const embedded = part("already-present", 10);
    const result = partitionInlineCidParts([small, large, embedded], [embedded.cid]);
    expect(result.smallBatchParts).toEqual([small]);
    expect(result.largeStreamParts).toEqual([large]);
    expect(result.overflowStreamParts).toEqual([]);
  });

  it("fails closed when one CID names different physical MIME parts", () => {
    const first = { ...part("same", 100), part: "2" };
    const second = { ...part("SAME", 200), part: "3" };
    const result = partitionInlineCidParts([first, second]);
    expect(result.smallBatchParts).toEqual([]);
    expect(result.largeStreamParts).toEqual([]);
    expect(result.overflowStreamParts).toEqual([]);
    expect(result.oversizedUnsafeParts).toEqual([]);

    expect(partitionInlineCidParts([first, { ...first }]).smallBatchParts).toEqual([first]);
  });

  it("enforces 20 parts, 256 KiB each and 1 MiB aggregate for the fast batch", () => {
    const candidates = Array.from({ length: 25 }, (_, index) => part(`small-${index}`, 52 * 1024));
    const result = partitionInlineCidParts(candidates);
    expect(result.smallBatchParts.length).toBeLessThanOrEqual(20);
    expect(result.smallBatchParts.every((item) => item.size <= INLINE_CID_FAST_MAX_BYTES)).toBe(
      true,
    );
    expect(result.smallBatchParts.reduce((sum, item) => sum + item.size, 0)).toBeLessThanOrEqual(
      INLINE_CID_FAST_TOTAL_BYTES,
    );
    expect(result.overflowStreamParts.length).toBeGreaterThan(0);
  });

  it("never auto-loads malformed, non-image or over-5-MiB metadata", () => {
    const unsafe = [
      part("too-large", INLINE_CID_STREAM_MAX_BYTES + 1),
      part("svg", 100, "image/svg+xml"),
      { ...part("negative", 1), size: -1 },
    ];
    const result = partitionInlineCidParts(unsafe);
    expect(result.smallBatchParts).toEqual([]);
    expect(result.largeStreamParts).toEqual([]);
    expect(result.oversizedUnsafeParts).toEqual(unsafe);
  });

  it("streams large CIDs with concurrency one and returns transferable bytes", async () => {
    const largeBytes = Math.round(1.8 * 1024 * 1024);
    const parts = [part("one", largeBytes), part("two", 400 * 1024)];
    let active = 0;
    let maximum = 0;
    const mappings: Array<{ cid: string; mimeType: string; bytes: ArrayBuffer }> = [];
    await streamInlineCidPartsSequential(parts, {
      signal: new AbortController().signal,
      fetchPart: async (item) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return new Response(new Blob([new Uint8Array(item.size)], { type: item.mimeType }), {
          headers: {
            "Content-Type": item.mimeType,
            "Content-Length": String(item.size),
          },
        });
      },
      onMapping: (mapping) => mappings.push(mapping),
    });
    expect(maximum).toBe(1);
    expect(
      mappings.map((mapping) => [mapping.cid, mapping.mimeType, mapping.bytes.byteLength]),
    ).toEqual([
      ["one", "image/png", largeBytes],
      ["two", "image/png", 400 * 1024],
    ]);
    expect(JSON.stringify(mappings)).not.toContain("base64");
    expect(JSON.stringify(mappings)).not.toContain("blob:");
  });

  it("rejects an incompatible response MIME or an oversized declared/body length", async () => {
    const mappings = vi.fn();
    const candidates = [
      part("bad-mime", 300 * 1024),
      part("declared", 300 * 1024),
      part("body", 300 * 1024),
    ];
    await streamInlineCidPartsSequential(candidates, {
      signal: new AbortController().signal,
      fetchPart: async (item) => {
        if (item.cid === "bad-mime")
          return new Response("x", { headers: { "Content-Type": "text/html" } });
        if (item.cid === "declared")
          return new Response("x", {
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(INLINE_CID_STREAM_MAX_BYTES + 1),
            },
          });
        return new Response(
          new Blob([new Uint8Array(INLINE_CID_STREAM_MAX_BYTES + 1)], { type: "image/png" }),
          { headers: { "Content-Type": "image/png" } },
        );
      },
      onMapping: mappings,
    });
    expect(mappings).not.toHaveBeenCalled();
  });

  it("aborts stale navigation before mapping bytes or starting the next request", async () => {
    const controller = new AbortController();
    const onMapping = vi.fn();
    const fetchPart = vi.fn(async () => {
      controller.abort();
      return new Response(new Blob(["png"], { type: "image/png" }), {
        headers: { "Content-Type": "image/png" },
      });
    });
    await streamInlineCidPartsSequential([part("large", 300 * 1024), part("never", 300 * 1024)], {
      signal: controller.signal,
      fetchPart,
      onMapping,
    });
    expect(onMapping).not.toHaveBeenCalled();
    expect(fetchPart).toHaveBeenCalledTimes(1);
  });

  it("keeps large streaming after frame readiness and out of CID prefetch", () => {
    const source = readFileSync("src/routes/mail.tsx", "utf8");
    const viewer = source.slice(
      source.indexOf("function useInlineImageMappings"),
      source.indexOf("/** Body renderer"),
    );
    const prefetch = source.slice(
      source.indexOf("const prefetchCidForMessage"),
      source.indexOf("const prefetchMessage"),
    );
    expect(viewer).toContain("if (!largeReady || !messageKey) return");
    expect(viewer).toContain("const parts = smallPartition.smallBatchParts");
    expect(viewer).toContain("streamInlineCidPartsSequential");
    expect(viewer).toContain('fetch("/api/mail-inline-part"');
    expect(viewer).not.toContain('fetch("/api/mail-attachment"');
    expect(viewer).not.toContain("URL.createObjectURL");
    expect(viewer).toContain("signal: controller.signal");
    expect(viewer).toContain("controller.abort()");
    expect(source).toContain("onLoad={() => {");
    expect(source).toContain("readyRafRef.current = requestAnimationFrame(() => {");
    expect(source).toContain("onReady?.()");
    expect(prefetch).toContain(
      "partitionInlineCidParts(message.inlineParts, present).smallBatchParts",
    );
    expect(prefetch).not.toContain("largeStreamParts");
    expect(source).toContain("hasAttachments: result.body.attachments.length > 0");
    const inlinePartRoute = readFileSync("src/routes/api/mail-inline-part.ts", "utf8");
    expect(inlinePartRoute).toContain("signal: request.signal");
    expect(inlinePartRoute).toContain("/api/message-inline-part");
  });
});
