import { timingSafeEqual } from "node:crypto";

export interface BridgeKeyEnv {
  BRIDGE_API_KEY?: string;
  BRIDGE_API_KEY_NEXT?: string;
}

function normalizedKey(value: string | undefined): string | null {
  const key = value?.trim();
  return key ? key : null;
}

/**
 * Active HTTP-auth keyring.
 *
 * The primary key remains the signing authority for existing opaque Bridge
 * tokens; NEXT is accepted only at the request-auth boundary during rotation.
 */
export function configuredBridgeApiKeys(env: BridgeKeyEnv = process.env): string[] {
  const primary = normalizedKey(env.BRIDGE_API_KEY);
  const next = normalizedKey(env.BRIDGE_API_KEY_NEXT);
  return [...new Set([primary, next].filter((value): value is string => value !== null))];
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accept only one exact string header value matching one configured auth key. */
export function isBridgeApiKeyAuthorized(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "string" || keys.length === 0) return false;
  return keys.some((key) => constantTimeStringEqual(value, key));
}
