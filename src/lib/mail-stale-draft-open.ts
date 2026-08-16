/**
 * Pure decision helpers for the Draft-only stale-revision fence.
 *
 * These functions are called directly by mail.tsx so the behavioral tests
 * exercise the same production decision logic without mounting the page.
 */
import type { SavedDraftIdentity } from "@/lib/mail-saved-draft-guard";

export type DraftFetchLane = "interactive" | "background";
export type DraftOpenContextKind = "current-list" | "historical";

export type PreNetworkDraftDecision =
  | { type: "normal" }
  | { type: "discard" }
  | { type: "redirect"; identity: SavedDraftIdentity };

export type SettlementDraftDecision =
  | { type: "apply" }
  | { type: "discard" }
  | { type: "redirect"; identity: SavedDraftIdentity };

export function decidePreNetworkDraftOpen(input: {
  isDraft: boolean;
  lane: DraftFetchLane;
  contextKind: DraftOpenContextKind;
  staleIdentity?: SavedDraftIdentity | null;
}): PreNetworkDraftDecision {
  if (!input.isDraft || !input.staleIdentity) return { type: "normal" };
  if (input.lane === "background" || input.contextKind === "historical") {
    return { type: "discard" };
  }
  return { type: "redirect", identity: input.staleIdentity };
}

export function decideSettledDraftFetch(input: {
  isDraft: boolean;
  fetchedUid: number;
  lane: DraftFetchLane;
  contextKind: DraftOpenContextKind;
  staleIdentity?: SavedDraftIdentity | null;
}): SettlementDraftDecision {
  if (
    !input.isDraft ||
    !input.staleIdentity ||
    input.staleIdentity.uid === input.fetchedUid
  ) {
    return { type: "apply" };
  }
  if (input.lane === "background" || input.contextKind === "historical") {
    return { type: "discard" };
  }
  return { type: "redirect", identity: input.staleIdentity };
}
