// Pure helpers for Mail Sync Queue retry/backoff logic and error
// classification. Client-safe, no side effects. All queue Worker code
// MUST use these helpers instead of inlining error string matching.
//
// The backoff formula is: min(cap, base * 2^attempt) with symmetric
// jitter of ±jitterFraction * delay. Deterministic when a `random()`
// injection is provided (used by tests).

import { MAIL_QUEUE_CONFIG } from "./mail-queue-config";

/**
 * Retryable errors: transient network/IMAP/rate-limit issues the worker
 * should back off and retry.
 * Non-retryable: authentication or configuration problems where retrying
 * without human intervention is pointless (and hazardous — hammering an
 * IMAP server with a bad password will trip abuse detection).
 */
export type MailQueueErrorCode =
  | "NETWORK"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "IMAP_TEMPORARY"
  | "RATE_LIMIT"
  | "MAIL_SYNC_BUSY"
  | "AUTH"
  | "ACCOUNT_DISABLED"
  | "INVALID_CONFIG"
  | "UNKNOWN";

const RETRYABLE = new Set<MailQueueErrorCode>([
  "NETWORK",
  "TIMEOUT",
  "UNAVAILABLE",
  "IMAP_TEMPORARY",
  "RATE_LIMIT",
  "MAIL_SYNC_BUSY",
]);

const NON_RETRYABLE = new Set<MailQueueErrorCode>([
  "AUTH",
  "ACCOUNT_DISABLED",
  "INVALID_CONFIG",
]);

export function isRetryableCode(code: MailQueueErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function isNonRetryableCode(code: MailQueueErrorCode): boolean {
  return NON_RETRYABLE.has(code);
}

/**
 * Classify a raw error/message string into a MailQueueErrorCode.
 * Never returns AUTH/ACCOUNT_DISABLED/INVALID_CONFIG based on caller
 * strings alone — those must come from the mail-sync runner where the
 * caller already knows the specific failure.
 */
export function classifyBridgeError(input: {
  code?: string | null;
  message?: string | null;
}): MailQueueErrorCode {
  const code = (input.code ?? "").toUpperCase();
  const msg = (input.message ?? "").toLowerCase();

  if (code === "MAIL_SYNC_BUSY" || msg.includes("locked") || msg.includes("busy")) {
    return "MAIL_SYNC_BUSY";
  }
  if (code === "AUTH" || code === "AUTHENTICATIONFAILED" || msg.includes("authenticationfailed") || msg.includes("invalid credentials") || msg.includes("auth failed")) {
    return "AUTH";
  }
  if (code === "ACCOUNT_DISABLED") return "ACCOUNT_DISABLED";
  if (code === "INVALID_CONFIG" || code === "CONFIG_LOAD_FAILED") return "INVALID_CONFIG";
  if (code === "TIMEOUT" || code === "ETIMEDOUT" || msg.includes("timeout") || msg.includes("timed out")) {
    return "TIMEOUT";
  }
  if (code === "RATE_LIMIT" || msg.includes("too many") || msg.includes("rate limit")) {
    return "RATE_LIMIT";
  }
  if (code === "UNAVAILABLE" || msg.includes("service unavailable")) return "UNAVAILABLE";
  if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("enotfound")) {
    return "NETWORK";
  }
  if (msg.includes("imap")) return "IMAP_TEMPORARY";
  return "UNKNOWN";
}

/**
 * Compute retry delay in seconds. Applies exponential backoff capped and
 * jittered per SSOT config. `attempt` is 1-based (first failure = 1).
 */
export function computeBackoffSeconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  const { baseSeconds, capSeconds, jitterFraction } = MAIL_QUEUE_CONFIG.backoff;
  if (!Number.isFinite(attempt) || attempt < 1) attempt = 1;
  const raw = baseSeconds * Math.pow(2, attempt - 1);
  const capped = Math.min(capSeconds, raw);
  const jitter = capped * jitterFraction * (random() * 2 - 1); // ±jitterFraction
  const delay = Math.max(1, Math.round(capped + jitter));
  return Math.min(capSeconds, delay);
}

/**
 * Decide next state for a failed job based on classified code and current
 * attempt count. Returns 'retry' (with delay), 'dead' (give up), or
 * 'non_retryable' (route to dead-letter immediately, no retries).
 */
export function decideFailureAction(input: {
  code: MailQueueErrorCode;
  attempt: number;
  random?: () => number;
}): { action: "retry" | "dead"; delaySeconds: number } {
  const { code, attempt } = input;
  const { maxAttempts } = MAIL_QUEUE_CONFIG.backoff;

  if (isNonRetryableCode(code)) {
    // AUTH / ACCOUNT_DISABLED / INVALID_CONFIG never retry — send straight
    // to dead-letter for operator attention.
    return { action: "dead", delaySeconds: 0 };
  }
  if (attempt >= maxAttempts) {
    return { action: "dead", delaySeconds: 0 };
  }
  return {
    action: "retry",
    delaySeconds: computeBackoffSeconds(attempt, input.random),
  };
}
