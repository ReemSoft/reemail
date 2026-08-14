// Cloudflare worker-lifetime guard for background persistence.
//
// Cloudflare Workers terminate floating promises after the response is
// returned. Every persistent cache write must be registered with the
// ExecutionContext (request.runtime.cloudflare.context / request.waitUntil,
// surfaced by Nitro's cloudflare-module `_module-handler.mjs`) so it survives
// the response -- while never blocking the response itself.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveCloudflareWaitUntil, type WaitUntil } from "../cloudflare-wait-until";

function augmentedRequest(contextWaitUntil?: WaitUntil, requestWaitUntil?: WaitUntil): Request {
  return {
    runtime: contextWaitUntil
      ? { cloudflare: { context: { waitUntil: contextWaitUntil } } }
      : undefined,
    waitUntil: requestWaitUntil,
  } as unknown as Request;
}

describe("MAILMAESTRO_CLOUDFLARE_CID_PERSISTENCE", () => {
  it("resolves the ExecutionContext waitUntil attached to a worker Request", () => {
    const calls: Array<Promise<unknown>> = [];
    const contextWaitUntil: WaitUntil = (promise) => calls.push(promise);
    const waitUntil = resolveCloudflareWaitUntil(augmentedRequest(contextWaitUntil));
    expect(typeof waitUntil).toBe("function");
    const promise = Promise.resolve();
    waitUntil!(promise);
    expect(calls).toEqual([promise]);
  });

  it("falls back to the bound request.waitUntil when no runtime context exists", () => {
    const calls: Array<Promise<unknown>> = [];
    const requestWaitUntil: WaitUntil = (promise) => calls.push(promise);
    const waitUntil = resolveCloudflareWaitUntil(augmentedRequest(undefined, requestWaitUntil));
    expect(typeof waitUntil).toBe("function");
    const promise = Promise.resolve();
    waitUntil!(promise);
    expect(calls).toEqual([promise]);
  });

  it("prefers the ExecutionContext waitUntil over request.waitUntil", () => {
    const ctxCalls: Array<Promise<unknown>> = [];
    const reqCalls: Array<Promise<unknown>> = [];
    const contextWaitUntil: WaitUntil = (promise) => ctxCalls.push(promise);
    const requestWaitUntil: WaitUntil = (promise) => reqCalls.push(promise);
    const waitUntil = resolveCloudflareWaitUntil(
      augmentedRequest(contextWaitUntil, requestWaitUntil),
    );
    const promise = Promise.resolve();
    waitUntil!(promise);
    expect(ctxCalls).toEqual([promise]);
    expect(reqCalls).toEqual([]);
  });

  it("returns undefined for plain or missing Requests (dev server, tests)", () => {
    expect(resolveCloudflareWaitUntil(undefined)).toBeUndefined();
    expect(resolveCloudflareWaitUntil({} as Request)).toBeUndefined();
  });

  it("registers the CID persistence write with waitUntil in the persist branch", () => {
    const server = readFileSync(
      new URL("../mail-message-open.functions.ts", import.meta.url),
      "utf8",
    );
    expect(server).toContain("getCloudflareWaitUntil()");
    expect(server).toContain("waitUntil?.(promise);");
    expect(server).toContain("cache.storeCachedInlineImages(");
    const persistBranch = server.slice(
      server.indexOf("store: data.persist"),
      server.indexOf(": async () => undefined,"),
    );
    expect(persistBranch).toContain("cache.storeCachedInlineImages(");
    expect(persistBranch).toContain("waitUntil?.(promise);");
    expect(persistBranch).not.toMatch(/void\s*cache\.storeCachedInlineImages/);
    expect(server).not.toMatch(/void\s+cache\s*\n?\s*\.storeCachedInlineImages/);
  });

  it("every floating persistent-cache write is registered, none left untracked", () => {
    const server = readFileSync(
      new URL("../mail-message-open.functions.ts", import.meta.url),
      "utf8",
    );
    const accessor = readFileSync(
      new URL("../cloudflare-wait-until.server.ts", import.meta.url),
      "utf8",
    );
    expect(server).toContain("trackCloudflareWork(");
    expect(server).toContain("getCloudflareWaitUntil()");
    // The accessor must use the supported runtime surface, never a new fetch.
    expect(accessor).toContain('from "@tanstack/react-start/server"');
    expect(accessor).toContain("getRequest()");
    expect(accessor).toContain("resolveCloudflareWaitUntil(");
    expect(accessor).toContain("waitUntil(promise)");
    // No browser round-trip workaround for persistence is introduced.
    expect(server).not.toContain("persistCache");
    expect(accessor).not.toContain("fetch(");
  });
});
