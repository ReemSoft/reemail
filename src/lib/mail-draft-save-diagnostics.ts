/**
 * PII-safe Draft save-trigger diagnostics.
 *
 * These fields travel only with the existing Draft save request and are
 * logged by the Bridge. They must never contain subject, body, recipient,
 * email, draftId, UID, filename, or messageId.
 */
export const DRAFT_SAVE_TRIGGER_REASONS = [
  "automatic",
  "explicit",
  "close",
  "send",
  "attachment-ready",
  "other-internal",
] as const;

export type DraftSaveTriggerReason = (typeof DRAFT_SAVE_TRIGGER_REASONS)[number];

export interface DraftSaveTriggerDiagnostics {
  reason: DraftSaveTriggerReason;
  generation: number;
  inFlight: boolean;
  coalesced: boolean;
  dirty: boolean;
  attachmentsChanged: boolean;
}
