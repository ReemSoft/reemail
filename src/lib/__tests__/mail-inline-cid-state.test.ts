import { describe, expect, it } from "vitest";
import {
  mergeResolvedCidImagesStable,
  type ResolvedCidImageState,
} from "@/lib/mail-inline-cid-state";

const image = (
  cid: string,
  dataUri = "data:image/png;base64,YQ==",
  width = 10,
  height = 20,
) => ({ cid, dataUri, width, height });

describe("mergeResolvedCidImagesStable", () => {
  it("preserves state identity when the effective mapping is unchanged", () => {
    const current: ResolvedCidImageState = {
      key: "message-a",
      images: [image("Logo@CID")],
    };

    const next = mergeResolvedCidImagesStable(current, "message-a", [image("logo@cid")]);

    expect(next).toBe(current);
  });

  it("creates new state when bytes or dimensions change", () => {
    const current: ResolvedCidImageState = {
      key: "message-a",
      images: [image("logo@cid")],
    };

    const changedBytes = mergeResolvedCidImagesStable(current, "message-a", [
      image("logo@cid", "data:image/png;base64,Yg=="),
    ]);
    expect(changedBytes).not.toBe(current);

    const changedDimensions = mergeResolvedCidImagesStable(current, "message-a", [
      image("logo@cid", "data:image/png;base64,YQ==", 11, 20),
    ]);
    expect(changedDimensions).not.toBe(current);
  });

  it("adds a new CID without dropping existing mappings", () => {
    const current: ResolvedCidImageState = {
      key: "message-a",
      images: [image("a@cid")],
    };

    const next = mergeResolvedCidImagesStable(current, "message-a", [image("b@cid")]);

    expect(next.images.map((entry) => entry.cid)).toEqual(["a@cid", "b@cid"]);
  });

  it("ignores stale decoded results for a different message key", () => {
    const current: ResolvedCidImageState = {
      key: "message-b",
      images: [image("b@cid")],
    };

    expect(mergeResolvedCidImagesStable(current, "message-a", [image("a@cid")])).toBe(current);
  });
});
