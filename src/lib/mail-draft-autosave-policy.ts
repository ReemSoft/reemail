export const TEXT_DRAFT_REMOTE_IDLE_MS = 5_000;
export const ATTACHMENT_DRAFT_REMOTE_IDLE_MS = 30_000;
export const ATTACHMENT_DRAFT_REMOTE_MIN_INTERVAL_MS = 60_000;

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
  if (!input.automatic) return { allowed: true, delayMs: 0 };
  if (input.sending) return { allowed: false, delayMs: 0 };
  if (!input.hasAttachments) return { allowed: true, delayMs: TEXT_DRAFT_REMOTE_IDLE_MS };
  const intervalDelay = input.lastSuccessfulAutomaticSaveAt
    ? Math.max(
        0,
        input.lastSuccessfulAutomaticSaveAt + ATTACHMENT_DRAFT_REMOTE_MIN_INTERVAL_MS - input.now,
      )
    : 0;
  return {
    allowed: true,
    delayMs: Math.max(ATTACHMENT_DRAFT_REMOTE_IDLE_MS, intervalDelay),
  };
}
