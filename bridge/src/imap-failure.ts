export type SafeImapFailureCode =
  | "IMAP_TIMEOUT"
  | "IMAP_CONNECTION_CLOSED"
  | "IMAP_CONNECTION_RESET"
  | "IMAP_AUTH_FAILED"
  | "IMAP_PERMISSION_DENIED"
  | "IMAP_QUOTA_EXCEEDED"
  | "IMAP_MAILBOX_UNAVAILABLE"
  | "IMAP_PROTOCOL_ERROR"
  | "IMAP_UNKNOWN";

export interface ClassifiedImapFailure {
  code: SafeImapFailureCode;
  retryable: boolean;
}

type ImapErrorShape = {
  code?: unknown;
  responseStatus?: unknown;
  serverResponseCode?: unknown;
  name?: unknown;
  message?: unknown;
};

function errorTokens(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const shaped = error as ImapErrorShape;
  return [
    shaped.code,
    shaped.responseStatus,
    shaped.serverResponseCode,
    shaped.name,
    shaped.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toUpperCase();
}

/** Classifies IMAP failures without returning raw provider text or user data. */
export function classifyImapFailure(error: unknown): ClassifiedImapFailure {
  const tokens = errorTokens(error);
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|TIMED OUT/.test(tokens))
    return { code: "IMAP_TIMEOUT", retryable: true };
  if (/ECONNRESET|ECONNABORTED|CONNECTION RESET/.test(tokens))
    return { code: "IMAP_CONNECTION_RESET", retryable: true };
  if (/ECONNECTIONCLOSED|EPIPE|NOT CONNECTED|CONNECTION CLOSED|SOCKET CLOSED/.test(tokens))
    return { code: "IMAP_CONNECTION_CLOSED", retryable: true };
  if (/AUTHENTICATIONFAILED|AUTH FAILED|EAUTH/.test(tokens))
    return { code: "IMAP_AUTH_FAILED", retryable: false };
  if (/OVERQUOTA|QUOTA/.test(tokens)) return { code: "IMAP_QUOTA_EXCEEDED", retryable: false };
  if (/NOPERM|PERMISSION|EACCES/.test(tokens))
    return { code: "IMAP_PERMISSION_DENIED", retryable: false };
  if (/NONEXISTENT|TRYCREATE|MAILBOX UNAVAILABLE|UNAVAILABLE/.test(tokens))
    return { code: "IMAP_MAILBOX_UNAVAILABLE", retryable: true };
  if (/EPROTO|PROTOCOL|\bBAD\b|\bNO\b/.test(tokens))
    return { code: "IMAP_PROTOCOL_ERROR", retryable: false };
  return { code: "IMAP_UNKNOWN", retryable: false };
}
