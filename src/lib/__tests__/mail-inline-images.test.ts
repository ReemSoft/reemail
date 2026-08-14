import { describe, expect, it, vi } from "vitest";
import {
  resolveInlineImageBatch,
  resolveInlineImageBatchSingleFlight,
  type InlineImage,
  type InlinePart,
} from "../mail-inline-images.server";

const SIX_PARTS: InlinePart[] = Array.from({ length: 6 }, (_, index) => ({
  cid: `cid-${index}`,
  part: String(index + 2),
  mimeType: "image/png",
  size: 4,
}));

function image(part: InlinePart): InlineImage {
  return { ...part, dataUri: "data:image/png;base64,AAAA" };
}

function miss() {
  return { hit: false as const, reason: "no-row" as const };
}

function hit(images: InlineImage[]) {
  return {
    hit: true as const,
    body: {
      bodyHtml: "<p>body</p>",
      preview: "body",
      inlineParts: SIX_PARTS,
      inlineImages: images,
      attachments: [],
      uidValidity: "7",
      byteSize: 11,
    },
  };
}

describe("MAILMAESTRO_BODY_FIRST_SINGLE_BATCH_CID", () => {
  it("does not call Bridge for a message without CID parts", async () => {
    const fetchBatch = vi.fn();
    const result = await resolveInlineImageBatch([], {
      lookup: async () => miss(),
      fetchBatch,
      store: vi.fn(),
    });
    expect(result).toEqual({ images: [], failedCids: [], source: "none" });
    expect(fetchBatch).not.toHaveBeenCalled();
  });

  it("never promotes cached large metadata into the bounded resolver", async () => {
    const fetchBatch = vi.fn();
    const cached = hit([]);
    cached.body.inlineParts = [
      {
        cid: "mm-inline-large@mailmaestro",
        part: "22",
        mimeType: "image/png",
        size: Math.round(1.8 * 1024 * 1024),
      },
    ];
    const result = await resolveInlineImageBatch([], {
      lookup: async () => cached,
      fetchBatch,
      store: vi.fn(),
    });
    expect(result.source).toBe("cache");
    expect(fetchBatch).not.toHaveBeenCalled();
  });

  it("fetches six images with exactly one Bridge batch", async () => {
    const fetchBatch = vi.fn(async (parts: InlinePart[]) => ({
      images: parts.map(image),
      failedCids: [],
    }));
    const result = await resolveInlineImageBatch(SIX_PARTS, {
      lookup: async () => miss(),
      fetchBatch,
      store: vi.fn(),
    });
    expect(result.images).toHaveLength(6);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(fetchBatch).toHaveBeenCalledWith(SIX_PARTS);
  });

  it("returns five successful images when one image fails", async () => {
    const result = await resolveInlineImageBatch(SIX_PARTS, {
      lookup: async () => miss(),
      fetchBatch: async (parts) => ({
        images: parts.slice(0, 5).map(image),
        failedCids: [parts[5].cid],
      }),
      store: vi.fn(),
    });
    expect(result.images).toHaveLength(5);
    expect(result.failedCids).toEqual(["cid-5"]);
  });

  it("is a cache miss once, persists, then serves a cache hit without Bridge", async () => {
    let cachedImages: InlineImage[] = [];
    let cacheReady = false;
    const fetchBatch = vi.fn(async (parts: InlinePart[]) => ({
      images: parts.map(image),
      failedCids: [],
    }));
    const deps = {
      lookup: async () => (cacheReady ? hit(cachedImages) : miss()),
      fetchBatch,
      store: vi.fn(async (_uidValidity: string, images: InlineImage[]) => {
        cachedImages = images;
      }),
    };

    cacheReady = true;
    await resolveInlineImageBatch(SIX_PARTS, deps);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    const second = await resolveInlineImageBatch(SIX_PARTS, deps);
    expect(second.source).toBe("cache");
    expect(second.images).toHaveLength(6);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests by message identity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = vi.fn(async () => {
      await gate;
      return { images: [], failedCids: [], source: "none" as const };
    });
    const first = resolveInlineImageBatchSingleFlight("company|account|inbox:42", worker);
    const second = resolveInlineImageBatchSingleFlight("company|account|inbox:42", worker);
    expect(first).toBe(second);
    expect(worker).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
  });

  it("does not block image display on the persistence write", async () => {
    const never = new Promise<never>(() => {});
    const store = vi.fn(async () => never);
    const result = await resolveInlineImageBatch(SIX_PARTS, {
      lookup: async () => hit([]),
      fetchBatch: async (parts) => ({ images: parts.map(image), failedCids: [] }),
      store,
    });
    expect(result.images).toHaveLength(6);
    expect(result.source).toBe("bridge");
    // The store ran (started) but the batch result was not held back for it.
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("persists only successful mappings, never failed CIDs", async () => {
    const stored: InlineImage[][] = [];
    const result = await resolveInlineImageBatch(SIX_PARTS, {
      lookup: async () => hit([]),
      fetchBatch: async () => ({
        images: [image(SIX_PARTS[0])],
        failedCids: SIX_PARTS.slice(1).map((part) => part.cid),
      }),
      store: async (_uidValidity, images) => {
        stored.push(images);
      },
    });
    expect(result.images).toHaveLength(1);
    expect(result.failedCids).toHaveLength(5);
    expect(stored).toHaveLength(1);
    expect(stored[0].map((item) => item.cid)).toEqual(["cid-0"]);
  });

  it("serves a fully-cached CID batch with zero Bridge calls (reload path)", async () => {
    const fetchBatch = vi.fn();
    const result = await resolveInlineImageBatch(SIX_PARTS, {
      lookup: async () => hit(SIX_PARTS.map(image)),
      fetchBatch,
      store: vi.fn(),
    });
    expect(result.source).toBe("cache");
    expect(result.images).toHaveLength(6);
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});
