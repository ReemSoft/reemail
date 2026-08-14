import { getRequest } from "@tanstack/react-start/server";
import { resolveCloudflareWaitUntil, type WaitUntil } from "@/lib/cloudflare-wait-until";

/**
 * Registers background work with the Cloudflare worker lifecycle for the
 * current request. Returns undefined outside a Cloudflare request (e.g. the
 * local dev server or tests), where promises are not terminated after the
 * response. Never throws.
 */
export function getCloudflareWaitUntil(): WaitUntil | undefined {
  try {
    return resolveCloudflareWaitUntil(getRequest());
  } catch {
    return undefined;
  }
}

/**
 * Keeps a fire-and-forget persistence write alive for the rest of the worker
 * invocation via `ExecutionContext.waitUntil` while never blocking the
 * response, and swallows the write's rejection.
 */
export function trackCloudflareWork(promise: Promise<unknown>): void {
  const waitUntil = getCloudflareWaitUntil();
  if (waitUntil) waitUntil(promise);
  promise.catch(() => undefined);
}
