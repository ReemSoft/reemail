export const NORMAL_SEND_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isNormalSendId(value: unknown): value is string {
  return typeof value === "string" && NORMAL_SEND_ID_RE.test(value);
}

function safeMessageIdDomain(emailAddress: string): string {
  const at = emailAddress.lastIndexOf("@");
  const candidate = at >= 0 ? emailAddress.slice(at + 1).trim().toLowerCase() : "";
  return candidate.length > 0 &&
    candidate.length <= 253 &&
    /^[a-z0-9.-]+$/i.test(candidate) &&
    !candidate.startsWith(".") &&
    !candidate.endsWith(".")
    ? candidate
    : "mailmaestro.local";
}

/**
 * Stable for one logical normal Compose send. The caller persists only sendId;
 * retries/reloads derive the same RFC Message-ID without storing message body.
 */
export function createNormalComposeMessageId(sendId: string, emailAddress: string): string {
  if (!isNormalSendId(sendId)) throw new Error("INVALID_SEND_ID");
  return `<mailmaestro.compose.${sendId.toLowerCase()}@${safeMessageIdDomain(emailAddress)}>`;
}
