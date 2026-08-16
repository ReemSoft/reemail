import { describe, expect, it } from "vitest";
import {
  decidePreNetworkDraftOpen,
  decideSettledDraftFetch,
} from "../mail-stale-draft-open";
import type { SavedDraftIdentity } from "../mail-saved-draft-guard";

const x: SavedDraftIdentity = {
  accountId: "acc-1",
  draftId: "draft-1",
  folderPath: "[Gmail]/Drafts",
  uidValidity: "42",
  uid: 100,
};
const y: SavedDraftIdentity = { ...x, uid: 101 };
const z: SavedDraftIdentity = { ...x, uid: 102 };

describe("decidePreNetworkDraftOpen", () => {
  it("redirects interactive stale X to current Y", () => {
    expect(
      decidePreNetworkDraftOpen({
        isDraft: true,
        lane: "interactive",
        contextKind: "current-list",
        staleIdentity: y,
      }),
    ).toEqual({ type: "redirect", identity: y });
  });

  it("uses normal path for current Y and non-Draft identities", () => {
    expect(
      decidePreNetworkDraftOpen({
        isDraft: true,
        lane: "interactive",
        contextKind: "current-list",
        staleIdentity: null,
      }),
    ).toEqual({ type: "normal" });
    expect(
      decidePreNetworkDraftOpen({
        isDraft: false,
        lane: "interactive",
        contextKind: "current-list",
        staleIdentity: y,
      }),
    ).toEqual({ type: "normal" });
  });

  it("discards background and historical stale work", () => {
    for (const lane of ["background"] as const) {
      expect(
        decidePreNetworkDraftOpen({
          isDraft: true,
          lane,
          contextKind: "current-list",
          staleIdentity: y,
        }),
      ).toEqual({ type: "discard" });
    }
    expect(
      decidePreNetworkDraftOpen({
        isDraft: true,
        lane: "interactive",
        contextKind: "historical",
        staleIdentity: y,
      }),
    ).toEqual({ type: "discard" });
  });
});

describe("decideSettledDraftFetch", () => {
  it("redirects an interactive obsolete X result to the latest identity once", () => {
    expect(
      decideSettledDraftFetch({
        isDraft: true,
        fetchedUid: x.uid,
        lane: "interactive",
        contextKind: "current-list",
        staleIdentity: z,
      }),
    ).toEqual({ type: "redirect", identity: z });
  });

  it("discards obsolete background/prefetch and historical results", () => {
    expect(
      decideSettledDraftFetch({
        isDraft: true,
        fetchedUid: x.uid,
        lane: "background",
        contextKind: "current-list",
        staleIdentity: y,
      }),
    ).toEqual({ type: "discard" });
    expect(
      decideSettledDraftFetch({
        isDraft: true,
        fetchedUid: x.uid,
        lane: "interactive",
        contextKind: "historical",
        staleIdentity: y,
      }),
    ).toEqual({ type: "discard" });
  });

  it("applies current and non-Draft results", () => {
    expect(
      decideSettledDraftFetch({
        isDraft: true,
        fetchedUid: y.uid,
        lane: "interactive",
        contextKind: "current-list",
        staleIdentity: y,
      }),
    ).toEqual({ type: "apply" });
    expect(
      decideSettledDraftFetch({
        isDraft: false,
        fetchedUid: x.uid,
        lane: "interactive",
        contextKind: "current-list",
        staleIdentity: y,
      }),
    ).toEqual({ type: "apply" });
  });
});
