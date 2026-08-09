import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DRAFT_REMOTE_IDLE_MS,
  ATTACHMENT_DRAFT_REMOTE_MIN_INTERVAL_MS,
  TEXT_DRAFT_REMOTE_IDLE_MS,
  planRemoteDraftSave,
} from "../mail-draft-autosave-policy";

describe("attachment-aware remote draft autosave policy", () => {
  it("keeps text-only automatic saves fast", () => {
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: false,
        sending: false,
        now: 100,
        lastSuccessfulAutomaticSaveAt: null,
      }).delayMs,
    ).toBe(TEXT_DRAFT_REMOTE_IDLE_MS);
  });

  it("debounces attachment-bearing automatic saves for 30 seconds", () => {
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: true,
        sending: false,
        now: 100,
        lastSuccessfulAutomaticSaveAt: null,
      }).delayMs,
    ).toBe(ATTACHMENT_DRAFT_REMOTE_IDLE_MS);
  });

  it("keeps 60 seconds between successful attachment automatic saves", () => {
    const now = 40_000;
    expect(
      planRemoteDraftSave({
        automatic: true,
        hasAttachments: true,
        sending: false,
        now,
        lastSuccessfulAutomaticSaveAt: 10_000,
      }).delayMs,
    ).toBe(ATTACHMENT_DRAFT_REMOTE_MIN_INTERVAL_MS - (now - 10_000));
  });

  it("manual saves are immediate and automatic saves are blocked during send", () => {
    expect(
      planRemoteDraftSave({
        automatic: false,
        hasAttachments: true,
        sending: true,
        now: 100,
        lastSuccessfulAutomaticSaveAt: 90,
      }),
    ).toEqual({ allowed: true, delayMs: 0 });
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
});
