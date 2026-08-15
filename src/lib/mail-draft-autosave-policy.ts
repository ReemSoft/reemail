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

export interface RemoteDraftSavePlanInput {
  automatic: boolean;
  hasAttachments: boolean;
  sending: boolean;
  now: number;
  lastSuccessfulAutomaticSaveAt: number | null;
}

export function planRemoteDraftSave(input: RemoteDraftSavePlanInput): {
  allowed: boolean;
  delayMs: number;
} {
  // Manual save bypasses the debounce and saves immediately.
  if (!input.automatic) return { allowed: true, delayMs: 0 };
  // Never autosave while a send is in flight.
  if (input.sending) return { allowed: false, delayMs: 0 };
  // The scheduler already applied DRAFT_REMOTE_IDLE_MS / DRAFT_MAX_DIRTY_MS;
  // flush immediately.
  return { allowed: true, delayMs: 0 };
}
