/**
 * Draft remote-autosave policy — MAILMAESTRO_DRAFTS_V4.
 *
 * The idle debounce is now owned by the Composer's autosave scheduler
 * (DRAFT_REMOTE_IDLE_MS) with an optional maximum dirty wait
 * (DRAFT_MAX_DIRTY_MS). Once the scheduler fires, the remote flush is
 * immediate (`delayMs: 0`), so there is no second hidden timer delaying
 * persistence.
 */
export const DRAFT_REMOTE_IDLE_MS = 1_500;
export const DRAFT_MAX_DIRTY_MS = 5_000;
export const DRAFT_ATTACHMENT_COOLDOWN_MIN_MS = 15_000;
export const DRAFT_ATTACHMENT_COOLDOWN_MAX_MS = 120_000;
export const DRAFT_SMALL_COOLDOWN_MIN_MS = 2_000;
export const DRAFT_SMALL_COOLDOWN_MAX_MS = 15_000;

export interface RemoteDraftSavePlanInput {
  automatic: boolean;
  hasAttachments: boolean;
  sending: boolean;
  now: number;
  lastSuccessfulAutomaticSaveAt: number | null;
  lastAutomaticSaveDurationMs?: number | null;
}

export function planRemoteDraftSave(input: RemoteDraftSavePlanInput): {
  allowed: boolean;
  delayMs: number;
} {
  // Manual save bypasses the debounce and saves immediately.
  if (!input.automatic) return { allowed: true, delayMs: 0 };
  // Never autosave while a send is in flight.
  if (input.sending) return { allowed: false, delayMs: 0 };
  if (input.lastSuccessfulAutomaticSaveAt === null || input.lastAutomaticSaveDurationMs == null) {
    return { allowed: true, delayMs: 0 };
  }
  const min = input.hasAttachments ? DRAFT_ATTACHMENT_COOLDOWN_MIN_MS : DRAFT_SMALL_COOLDOWN_MIN_MS;
  const max = input.hasAttachments ? DRAFT_ATTACHMENT_COOLDOWN_MAX_MS : DRAFT_SMALL_COOLDOWN_MAX_MS;
  const multiplier = input.hasAttachments ? 1.5 : 0.5;
  const cooldown = Math.min(
    max,
    Math.max(min, Math.round(input.lastAutomaticSaveDurationMs * multiplier)),
  );
  const elapsed = Math.max(0, input.now - input.lastSuccessfulAutomaticSaveAt);
  return { allowed: true, delayMs: Math.max(0, cooldown - elapsed) };
}
