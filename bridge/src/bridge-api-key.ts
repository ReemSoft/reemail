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
 * tokens. Once NEXT is configured, HTTP auth switches exclusively to NEXT so
 * the exposed old primary is revoked from the network boundary while legacy
 * transfer tickets and staged handles can finish under the old signing key.
 *
 * After the legacy-token TTL drains, NEXT can be promoted to BRIDGE_API_KEY
 * and removed; HTTP auth then naturally falls back to the new primary.
 */
export function configuredBridgeApiKeys(env: BridgeKeyEnv = process.env): string[] {
  const primary = normalizedKey(env.BRIDGE_API_KEY);
  const next = normalizedKey(env.BRIDGE_API_KEY_NEXT);
  if (next) return [next];
  return primary ? [primary] : [];
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
