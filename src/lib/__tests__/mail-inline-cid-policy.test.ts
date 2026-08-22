import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  INLINE_CID_FAST_MAX_BYTES,
  INLINE_CID_FAST_TOTAL_BYTES,
  INLINE_CID_STREAM_MAX_BYTES,
  chunkInlineCidParts,
  extractReferencedInlineCids,
  partitionInlineCidParts,
  streamInlineCidPartsSequential,
  type InlineCidPart,
} from "../mail-inline-cid-policy";

function part(cid: string, size: number, mimeType = "image/png"): InlineCidPart {
  return { cid, part: String(cid.length + 1), mimeType, size };
}

describe("visible inline CID scope", () => {
  it("extracts only unique img cid references from the rendered HTML fragment", () => {
    const html = [
      '<p><img src="cid:Logo%40Example.COM"></p>',
      '<a href="cid:not-an-image">link</a>',
      '<img src="https://example.com/remote.png">',
      "<img SRC=' cid:&lt;SECOND@Example.com&gt;'>",
      '<img src="cid:logo%40example.com">',
    ].join("");

    expect(extractReferencedInlineCids(html)).toEqual([
      "logo@example.com",
      "second@example.com",
    ]);
  });

  it("keeps extraction bounded and ignores cid text outside img src", () => {
    const html =
      "cid:plain-text " +
      Array.from({ length: 60 }, (_, index) => `<img src="cid:image-${index}@example">`).join("");

    const cids = extractReferencedInlineCids(html);
    expect(cids).toHaveLength(50);
    expect(cids[0]).toBe("image-0@example");
    expect(cids[49]).toBe("image-49@example");
  });
});

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

  it("fails closed when one CID is reused by a different part even with matching MIME and size", () => {
    const first = { ...part("signature-logo", 4096, "image/png"), part: "2.1" };
    const repeated = { ...first, cid: "SIGNATURE-LOGO", part: "7.4.2" };
    const result = partitionInlineCidParts([first, repeated]);
    expect(result.smallBatchParts).toEqual([]);
    expect(result.largeStreamParts).toEqual([]);
    expect(result.overflowStreamParts).toEqual([]);
    expect(result.oversizedUnsafeParts).toEqual([]);
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

  it("never auto-loads malformed, non-image or over-25-MiB metadata", () => {
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

  it("chunks deferred images by both five-part and 25 MiB request limits", () => {
    const batches = chunkInlineCidParts([
      part("one", 14 * 1024 * 1024),
      part("two", 14 * 1024 * 1024),
      ...Array.from({ length: 6 }, (_, index) => part(`small-${index}`, 1)),
    ]);
    expect(batches.map((batch) => batch.map((item) => item.cid))).toEqual([
      ["one"],
      ["two", "small-0", "small-1", "small-2", "small-3"],
      ["small-4", "small-5"],
    ]);
    expect(
      batches.every(
        (batch) =>
          batch.length <= 5 &&
          batch.reduce((total, item) => total + item.size, 0) <= 25 * 1024 * 1024,
      ),
    ).toBe(true);
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

  it("hydrates only CIDs reported by loaded visible message frames", () => {
    const source = readFileSync("src/routes/mail.tsx", "utf8");
    const viewer = source.slice(
      source.indexOf("function useInlineImageMappings"),
      source.indexOf("/** Body renderer"),
    );
    const body = source.slice(
      source.indexOf("function MessageBody"),
      source.indexOf("function TruncatedBodyWarning"),
    );
    const threaded = source.slice(
      source.indexOf("function ThreadedEmailBody"),
      source.indexOf("type InlineImageFlight"),
    );
    const frame = source.slice(
      source.indexOf("function EmailBodyFrame"),
      source.indexOf("/**\n * ThreadedEmailBody"),
    );

    expect(viewer).toContain("visibleCids: readonly string[]");
    expect(viewer).toContain("const visibleCidSet = useMemo");
    expect(viewer).toContain("(message.inlineParts ?? []).filter");
    expect(viewer).toContain("visibleCidSet.has(normalizeCid(part.cid))");
    expect(viewer).toContain("visibleCidSet.has(normalizeCid(image.cid))");
    expect(viewer.indexOf("visibleInlineParts")).toBeLessThan(
      viewer.indexOf("partitionInlineCidParts("),
    );

    expect(body).toContain("visibleCidScopesRef");
    expect(body).toContain("visibleCids,");
    expect(body).toContain("onCidScopeChange={handleCidScopeChange}");

    // Image eligibility is announced only from iframe onLoad's RAF, after the
    // body has already rendered. It is never part of the message-open fetch.
    expect(frame).toContain("onLoad={() => {");
    expect(frame).toContain("requestAnimationFrame(() => {");
    expect(frame).toContain(
      "onCidScopeChange?.(messageIdentity, extractReferencedInlineCids(html))",
    );
    expect(frame).not.toContain("useMemo(() => extractReferencedInlineCids");
    expect(frame.indexOf("extractReferencedInlineCids(html)")).toBeGreaterThan(
      frame.indexOf("onLoad={() => {"),
    );
    expect(frame).toContain("onCidScopeChange?.(messageIdentity, [])");

    // Every actual body iframe participates. The quoted two are still rendered
    // only inside the existing expanded branch, so collapsed history has no
    // registered CID scope and starts zero image requests.
    expect(threaded.split("onCidScopeChange={onCidScopeChange}").length - 1).toBe(5);
    expect(threaded).toContain("{expanded &&");
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
    expect(viewer).toContain("const parts = inlinePartition.smallBatchParts");
    expect(viewer).toContain("...inlinePartition.overflowStreamParts");
    expect(viewer).toContain("const parts = deferredStreamParts");
    expect(viewer).toContain("fetchInlineCidPartsBatch");
    expect(viewer).toContain("parts: requested");
    expect(viewer).toContain("chunkInlineCidParts(cached.misses)");
    expect(viewer).not.toContain("streamInlineCidPartsSequential(parts");
    const composerHydration = source.slice(
      source.indexOf("// Set initial editor HTML once"),
      source.indexOf("// Poll extension registry occasionally"),
    );
    expect(composerHydration).toContain("const metadataReady = new Promise<void>");
    expect(composerHydration).toContain("markMetadataReady();");
    expect(composerHydration).toContain("chunkInlineCidParts(cached.misses)");
    expect(composerHydration).toContain("fetchInlineCidPartsBatch(batch");
    expect(composerHydration).not.toContain("streamInlineCidPartsSequential(");
    expect(source).toContain("inlineHydrationAbortRef.current?.abort()");
    expect(source).toContain("providerInlineSourcesAtSend.length > 0");
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


it("fans large CID mappings to every ready viewer frame without duplicate network hydration", () => {
  const mail = readFileSync("src/routes/mail.tsx", "utf8");

  expect(mail).toContain(
    "type LargeCidDispatcher = (images: LargeCidByteMapping[]) => void",
  );
  expect(mail).toContain(
    "useRef<Set<LargeCidDispatcher>>(new Set())",
  );
  expect(mail).toContain(
    "largeCidDispatchersRef.current.add(dispatch)",
  );
  expect(mail).toContain(
    "largeCidDispatchersRef.current.delete(dispatch)",
  );
  expect(mail).toContain("bytes: image.bytes.slice(0)");
  expect(mail).toContain("largeReplayVersion");
  expect(mail).toContain(
    "if (!largeReady || largeReplayVersion <= 1 || !messageKey) return;",
  );

  // Replay uses the already-bounded session cache only.
  expect(mail).toContain(
    "const cached = readLargeInlineCidSessionCache(messageKey, parts);",
  );
  expect(mail).toContain(
    "if (cached.hits.length) onLargeCid?.(cached.hits);",
  );

  // Both quoted fallback render paths must register with the same dispatcher
  // registry and trigger a replay once their iframe is actually ready.
  const quotedFrames =
    mail.match(
      /html=\{quoted\}[\s\S]{0,260}onReady=\{onReady\}[\s\S]{0,260}largeCidDispatchersRef=\{largeCidDispatchersRef\}/g,
    ) ?? [];
  expect(quotedFrames).toHaveLength(2);

  // The network fetch effect remains keyed only by largeReady/message identity;
  // replay generation must not be able to trigger another Bridge download.
  expect(mail).toContain(
    "}, [deferredStreamParts, largeReady, message.id, messageKey, onLargeCid, uidValidity]);",
  );
});
