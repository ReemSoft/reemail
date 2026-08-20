export const DELIVERY_PROGRESS_START = 72;
export const DELIVERY_PROGRESS_CAP = 89;

/**
 * Keep the delivery indicator moving while a single HTTP request is waiting
 * for MIME creation and SMTP acceptance. It never reaches the confirmation or
 * completion ranges before the server actually replies.
 */
export function deliveryProgressForElapsed(elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  const range = DELIVERY_PROGRESS_CAP - DELIVERY_PROGRESS_START;
  return Math.min(
    DELIVERY_PROGRESS_CAP,
    DELIVERY_PROGRESS_START + range * (1 - Math.exp(-elapsed / 14_000)),
  );
}
