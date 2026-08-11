import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const openSource = readFileSync(resolve(__dirname, "../mail-message-open.functions.ts"), "utf8");
const authSource = readFileSync(resolve(__dirname, "../mail-bridge-auth.server.ts"), "utf8");
const bridgeSource = readFileSync(resolve(__dirname, "../../../bridge/src/index.ts"), "utf8");

describe("MAILMAESTRO cold message open", () => {
  it("verifies JWT once, then starts config before awaiting the cache", () => {
    expect(openSource.match(/verifyBridgeAuthClaims\(data\.mailSessionToken\)/g)).toHaveLength(1);
    const configStart = openSource.indexOf(
      "const authPromise = resolveBridgeAuthForVerifiedClaims",
    );
    const cacheAwait = openSource.indexOf("lookupCachedBodyWithMailboxHint");
    expect(configStart).toBeGreaterThan(-1);
    expect(configStart).toBeLessThan(cacheAwait);
    expect(authSource).toContain("return resolveBridgeAuthForVerifiedClaims(claims)");
  });

  it("returns a cache hit before awaiting config and never calls Bridge", () => {
    const hit = openSource.indexOf("if (found?.hit)");
    const authAwait = openSource.indexOf("const auth = await authPromise");
    const bridgeCall = openSource.indexOf("const r = await bridgeCallResolved");
    expect(hit).toBeGreaterThan(-1);
    expect(hit).toBeLessThan(authAwait);
    expect(authAwait).toBeLessThan(bridgeCall);
  });

  it("keeps mailbox hints server-owned and excludes virtual folders", () => {
    expect(openSource).not.toMatch(/OpenSchema[\s\S]{0,800}mailboxPathHint/);
    expect(openSource).toContain('data.folder !== "starred" && data.folder !== "all"');
    expect(openSource).toContain("mailboxPathHint: mailboxHint.path");
    expect(openSource).toContain("expectedUidValidity: mailboxHint.expectedUidValidity");
  });

  it("keeps one protected Bridge route and only constructs paired hints", () => {
    expect(bridgeSource.match(/app\.post\("\/api\/message"/g)).toHaveLength(1);
    expect(bridgeSource).toContain("payload.mailboxPathHint && payload.expectedUidValidity");
    expect(bridgeSource).toContain("requireKey, messageGate");
  });
});
