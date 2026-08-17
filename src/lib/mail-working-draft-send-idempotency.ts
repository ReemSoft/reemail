/**
 * Pure state model for durable Draft-origin Send idempotency. The Supabase
 * RPC in supabase/migrations/20260817080000_mail_working_draft_sends.sql is
 * the production authority; these helpers document and test that state flow.
 */

export type WorkingDraftSendState = "preparing" | "sending" | "sent" | "failed";

export interface WorkingDraftSendAttempt {
  state: WorkingDraftSendState;
  leaseUntil: number | null;
}

export interface WorkingDraftSendClaimInput {
  attempt: WorkingDraftSendAttempt | null;
  now: number;
  leaseMs: number;
}

export interface WorkingDraftSendClaim {
  claimed: boolean;
  state: WorkingDraftSendState;
}

export const DEFINITE_PRE_SMTP_SEND_ERRORS = new Set([
  "INVALID_PAYLOAD",
  "SESSION_REQUIRED",
  "INVALID_INLINE_IMAGES",
  "ATTACHMENTS_TOO_LARGE",
  "ATTACHMENT_KIND_MISMATCH",
  "INLINE_CID_REQUIRED",
  "INVALID_STAGE_HANDLE",
  "STAGED_ATTACHMENT_NOT_FOUND",
  "SEND_BUSY",
  "SOURCE_MAILBOX_MISMATCH",
  "SOURCE_UIDVALIDITY_MISMATCH",
  "SOURCE_ATTACHMENT_MISSING",
  "SOURCE_ATTACHMENT_TOO_LARGE",
  "SOURCE_ATTACHMENT_IMPORT_FAILED",
]);

export function isDefinitePreSmtpSendError(value: unknown): value is string {
  return typeof value === "string" && DEFINITE_PRE_SMTP_SEND_ERRORS.has(value);
}

export function nextWorkingDraftSendClaim(
  input: WorkingDraftSendClaimInput,
): WorkingDraftSendClaim {
  if (!input.attempt) return { claimed: true, state: "preparing" };
  if (input.attempt.state === "sent") return { claimed: false, state: "sent" };
  if (input.attempt.state === "failed") return { claimed: true, state: "preparing" };
  if (input.attempt.state === "preparing") {
    const leaseExpired =
      input.attempt.leaseUntil === null ||
      input.now >= input.attempt.leaseUntil;
    return leaseExpired
      ? { claimed: true, state: "preparing" }
      : { claimed: false, state: "preparing" };
  }
  // state = 'sending' is ambiguous/in-flight and is never reclaimed automatically.
  return { claimed: false, state: "sending" };
}
