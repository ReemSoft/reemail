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

  it("streams large CIDs with concurrency one and creates Blob URLs only", async () => {
    const largeBytes = Math.round(1.8 * 1024 * 1024);
    const parts = [part("one", largeBytes), part("two", 400 * 1024)];
    let active = 0;
    let maximum = 0;
    const mappings: Array<{ cid: string; blobUrl: string }> = [];
    const createObjectURL = vi.fn((blob: Blob) => `blob:test/${blob.size}`);
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
      createObjectURL,
      revokeObjectURL: vi.fn(),
      onMapping: (mapping) => mappings.push(mapping),
    });
    expect(maximum).toBe(1);
    expect(mappings).toEqual([
      { cid: "one", blobUrl: `blob:test/${largeBytes}` },
      { cid: "two", blobUrl: `blob:test/${400 * 1024}` },
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mappings)).not.toContain("base64");
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
      createObjectURL: vi.fn(() => "blob:never"),
      revokeObjectURL: vi.fn(),
      onMapping: mappings,
    });
    expect(mappings).not.toHaveBeenCalled();
  });

  it("aborts stale navigation and revokes a URL created during the abort race", async () => {
    const controller = new AbortController();
    const revokeObjectURL = vi.fn();
    const onMapping = vi.fn();
    await streamInlineCidPartsSequential([part("large", 300 * 1024)], {
      signal: controller.signal,
      fetchPart: async () =>
        new Response(new Blob(["png"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        }),
      createObjectURL: () => {
        controller.abort();
        return "blob:test/stale";
      },
      revokeObjectURL,
      onMapping,
    });
    expect(onMapping).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test/stale");
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
    expect(viewer).toContain("signal: controller.signal");
    expect(viewer).toContain("controller.abort()");
    expect(viewer).toContain("URL.revokeObjectURL(url)");
    expect(source).toContain("onLoad={() => {");
    expect(source).toContain("readyRafRef.current = requestAnimationFrame(() => {");
    expect(source).toContain("onReady?.()");
    expect(prefetch).toContain(
      "partitionInlineCidParts(message.inlineParts, present).smallBatchParts",
    );
    expect(prefetch).not.toContain("largeStreamParts");
    expect(source).toContain("hasAttachments: result.body.attachments.length > 0");
    const attachmentRoute = readFileSync("src/routes/api/mail-attachment.ts", "utf8");
    expect(attachmentRoute).toContain("signal: request.signal");
  });
});
