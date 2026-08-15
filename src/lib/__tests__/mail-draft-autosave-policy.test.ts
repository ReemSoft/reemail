import { describe, expect, it } from "vitest";
import { DRAFT_MAX_DIRTY_MS, DRAFT_REMOTE_IDLE_MS, planRemoteDraftSave } from "../mail-draft-autosave-policy";

describe("draft remote autosave policy (scheduler-owned debounce)", () => {
  it("manual saves are immediate", () => {
    expect(
      planRemoteDraftSave({
        automatic: false,
        hasAttachments: true,
        sending: false,
        now: 100,
        lastSuccessfulAutomaticSaveAt: 90,
      }),
    ).toEqual({ allowed: true, delayMs: 0 });
  });

  it("automatic saves are blocked during send", () => {
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: false,
        sending: true,
        now: 100,
        lastSuccessfulAutomaticSaveAt: null,
      }).allowed,
    ).toBe(false);
  });

  it("automatic saves flush immediately (debounce is scheduler-owned)", () => {
    // Text and attachment drafts share the SAME policy — no 30s/60s delays.
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: false,
        sending: false,
        now: 100,
        lastSuccessfulAutomaticSaveAt: null,
      }),
    ).toEqual({ allowed: true, delayMs: 0 });
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: true,
        sending: false,
        now: 40_000,
        lastSuccessfulAutomaticSaveAt: 39_500,
      }),
    ).toEqual({ allowed: true, delayMs: 0 });
  });

  it("exposes the ~1.5s idle debounce and ~5s max dirty wait constants", () => {
    expect(DRAFT_REMOTE_IDLE_MS).toBe(1500);
    expect(DRAFT_MAX_DIRTY_MS).toBe(5000);
  });
});
