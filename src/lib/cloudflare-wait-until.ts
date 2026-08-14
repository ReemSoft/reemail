/**
 * Cloudflare Workers `ExecutionContext.waitUntil` surface for background
 * persistence, as surfaced by the Cloudflare module-worker preset that Nitro
 * emits for this app.
 *
 * `_module-handler.mjs` augments the incoming Request with
 * `request.runtime.cloudflare.context` (the ExecutionContext) and a bound
 * `request.waitUntil`. h3-v2 exposes the same surface through the H3Event it
 * builds around that Request, and TanStack Start's `getRequest()` hands back
 * that same augmented Request inside a server function.
 *
 * Deliberately dependency-free so the extraction logic is deterministically
 * unit-testable.
 */

export type WaitUntil = (promise: Promise<unknown>) => void;

export interface CloudflareWorkerExecutionContext {
  waitUntil?: WaitUntil;
}

export interface AugmentedWorkerRequest extends Request {
  waitUntil?: WaitUntil;
  runtime?: {
    cloudflare?: {
      context?: CloudflareWorkerExecutionContext;
    };
  };
}

/**
 * Resolves the Cloudflare ExecutionContext waitUntil from a worker Request.
 * Returns undefined for plain Requests (dev server, tests, non-Cloudflare).
 */
export function resolveCloudflareWaitUntil(request: Request | undefined): WaitUntil | undefined {
  if (!request) return undefined;
  const augmented = request as AugmentedWorkerRequest;
  const cfContext = augmented.runtime?.cloudflare?.context;
  return cfContext?.waitUntil?.bind(cfContext) ?? augmented.waitUntil;
}
