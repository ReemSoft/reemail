import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");
const indexSource = readFileSync(resolve(__dirname, "../mail-index.functions.ts"), "utf8");

describe("MAILMAESTRO_INSTANT_NAVIGATION_R1 route integration", () => {
  it("paints a list-row shell before awaiting the interactive body", () => {
    expect(source).toMatch(/setSelectedMessage\(base\);\s*setReading\(true\)/);
    expect(source).toMatch(/<MessageBodySkeleton\s*\/>/);
  });

  it("does not call the open Server Function on a memory hit", () => {
    expect(source).toMatch(/const result = cached\s*\? \(\{ message: cached, source: "memory" \}/);
    expect(source).toMatch(/: await fetchMessage\(id, "interactive"\)/);
  });

  it("drops stale navigation responses and clears all async state at scope boundaries", () => {
    expect(source).toMatch(/isCurrent\(generation\)/);
    expect(source).toMatch(/prefetchQueueRef\.current\?\.cancelAll\(\)/);
    expect(source).toMatch(/activeScopeGenerationRef\.current \+= 1/);
  });

  it("uses exactly one CID batch Server Function and no per-image HTTP loop", () => {
    expect(source).toMatch(/resolveInlineImages\(\{\s*data:/);
    expect(source).not.toMatch(/for \(const part of parts\)[\s\S]{0,300}resolveInlineImages/);
  });

  it("keeps the iframe sandbox and external-image privacy gate", () => {
    expect(source).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
    expect(source).toMatch(
      /buildEmailSrcDoc\(\{[\s\S]{0,200}messageIdentity,[\s\S]{0,100}generation,[\s\S]{0,100}allowRemoteImages/,
    );
    expect(source).toMatch(
      /const srcDoc = useMemo\([\s\S]*?\[html, nonce, channelId, messageIdentity, generation, parentOrigin, allowRemoteImages\]/,
    );
  });

  it("never mutates Seen/Flags from the prefetch implementation", () => {
    const prefetch = source.slice(
      source.indexOf("const prefetchMessage"),
      source.indexOf("useCompanyTheme"),
    );
    expect(prefetch).not.toMatch(/mutateFlag|markRead|bridgeMarkRead/);
  });

  it("invalidates moved/deleted rows and clears memory on logout", () => {
    expect(source.match(/messageCache\.current\.delete\(id\)/g)?.length).toBeGreaterThan(3);
    const logout = source.slice(
      source.indexOf("function handleSignOut"),
      source.indexOf("if (session === undefined)"),
    );
    expect(logout).toContain("resetAsyncScope(true)");
  });

  it("retains completed folder cache while cancelling old scope work", () => {
    const scopeEffect = source.slice(
      source.indexOf("// Folder switches cancel speculative work"),
      source.indexOf("// Clear deep search results"),
    );
    expect(scopeEffect).toContain("resetAsyncScope(identityChanged)");
    expect(scopeEffect).not.toContain("messageCache.current.clear()");
    expect(source).toContain("abortInflightControllers(inflight.current)");
    expect(source).toContain("cancelScheduledPrefetch(");
  });

  it("rotates CID identity and cancels a pending RAF", () => {
    expect(source).toMatch(
      /channelId = useMemo\([\s\S]{0,200}\[html, messageIdentity\],[\s\S]{0,10}\)/,
    );
    expect(source).toContain("cancelAnimationFrame(cidRafRef.current)");
    expect(source).toContain(
      "isValidCidApplyPayload(payload, channelId, messageIdentity, generation)",
    );
  });

  it("propagates authoritative Local Index UIDVALIDITY and disables every speculative path on Save-Data/2G", () => {
    expect(indexSource).toContain("uidValidity: folderUidValidity");
    expect(source).toMatch(
      /if \(!session \|\| loading \|\| folder === "drafts" \|\| !widePrefetch\) return/,
    );
    expect(source).toMatch(/if \(!selectedId \|\| !session \|\| !widePrefetch\) return/);
    expect(source).toMatch(
      /if \(!widePrefetch \|\| hoverPrefetchTimersRef\.current\.has\(id\)\) return/,
    );
    expect(source).toMatch(/if \(widePrefetch\)\s*void prefetchMessage/);
  });

  it("uses identity comparison before deleting message and CID flights", () => {
    expect(source).toContain("inflight.current.get(requestKey)?.promise === p");
    expect(source).toContain("inlineImageFlights.get(messageKey)?.promise === promise");
    expect(source).toContain("inlineImageFlights.get(key)?.promise === promise");
  });
});
