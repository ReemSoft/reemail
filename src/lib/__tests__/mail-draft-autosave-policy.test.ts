import { describe, expect, it } from "vitest";
import {
  DRAFT_ATTACHMENT_COOLDOWN_MAX_MS,
  DRAFT_ATTACHMENT_COOLDOWN_MIN_MS,
  DRAFT_MAX_DIRTY_MS,
  DRAFT_REMOTE_IDLE_MS,
  DRAFT_SMALL_COOLDOWN_MAX_MS,
  DRAFT_SMALL_COOLDOWN_MIN_MS,
  planRemoteDraftSave,
} from "../mail-draft-autosave-policy";

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

  it("coalesces attachment checkpoints with the exact 1.5x, 15s..120s policy", () => {
    expect(DRAFT_ATTACHMENT_COOLDOWN_MIN_MS).toBe(15_000);
    expect(DRAFT_ATTACHMENT_COOLDOWN_MAX_MS).toBe(120_000);
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: true,
        sending: false,
        now: 10_000,
        lastSuccessfulAutomaticSaveAt: 0,
        lastAutomaticSaveDurationMs: 20_000,
      }),
    ).toEqual({ allowed: true, delayMs: 20_000 });
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: true,
        sending: false,
        now: 0,
        lastSuccessfulAutomaticSaveAt: 0,
        lastAutomaticSaveDurationMs: 200_000,
      }),
    ).toEqual({ allowed: true, delayMs: 120_000 });
  });

  it("keeps small-draft checkpoints on the exact 0.5x, 2s..15s policy", () => {
    expect(DRAFT_SMALL_COOLDOWN_MIN_MS).toBe(2_000);
    expect(DRAFT_SMALL_COOLDOWN_MAX_MS).toBe(15_000);
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: false,
        sending: false,
        now: 0,
        lastSuccessfulAutomaticSaveAt: 0,
        lastAutomaticSaveDurationMs: 10_000,
      }),
    ).toEqual({ allowed: true, delayMs: 5_000 });
  });
});
