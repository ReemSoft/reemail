// Server-only: single place that talks to the private Mail Bridge.
// Extracted from mail-bridge.functions.ts so other server modules (body
// cache open path, background warmer) reuse the exact same trust model:
// host/port/credentials always resolved from the DB, never from the client.
import { resolveBridgeAuth, type BridgeAuthOk } from "@/lib/mail-bridge-auth.server";

export type BridgeCallResult =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { ok: true; json: any; auth: BridgeAuthOk }
  | { ok: false; error: string; status?: number; unavailable?: boolean };

export async function bridgeCallWithAuth(
  mailSessionToken: string,
  path: string,
  extraBody: Record<string, unknown>,
  password: string,
): Promise<BridgeCallResult> {
  const auth = await resolveBridgeAuth(mailSessionToken);
  if (!auth.ok) {
    return { ok: false, error: auth.error, unavailable: auth.code === "BRIDGE_NOT_CONFIGURED" };
  }
  return bridgeCallResolved(auth, path, extraBody, password);
}

export async function bridgeCallResolved(
  auth: BridgeAuthOk,
  path: string,
  extraBody: Record<string, unknown>,
  password: string,
): Promise<BridgeCallResult> {
  try {
    const res = await fetch(`${auth.bridgeUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Key": auth.bridgeKey,
      },
      body: JSON.stringify({
        account: auth.bridgeAccount,
        password,
        ...extraBody,
      }),
    });
    const json = await res.json().catch(() => ({ ok: false, error: "Bridge error" }));
    if (!res.ok || !json.ok) {
      return {
        ok: false,
        error: json.error || `Bridge error ${res.status}`,
        status: res.status,
      };
    }
    return { ok: true, json, auth };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    return { ok: false, error: msg || "تعذر الاتصال بخادم البريد" };
  }
}
