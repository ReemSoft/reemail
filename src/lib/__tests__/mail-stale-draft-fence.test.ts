// Draft stale-revision fence wiring regression guards.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

describe("Draft stale-revision fence wiring", () => {
  it("redirects a stale Draft UID before the network fetch", () => {
    const src = route();
    expect(src).toContain("findStale(");
    expect(src).toContain("decidePreNetworkDraftOpen(");
    const fetchBlock = src.slice(
      src.indexOf("const staleDraftIdentity ="),
      src.indexOf("const fetchUid = parsed.uid;"),
    );
    expect(fetchBlock).toContain('parsed.folder === "drafts"');
    expect(fetchBlock).not.toContain("openMsg({");
  });

  it("fences an already-running stale X result before apply/cleanup", () => {
    const src = route();
    const settlement = src.slice(
      src.indexOf("const staleAtSettlement ="),
      src.indexOf("if (context.kind === \"historical\") {"),
    );
    expect(settlement).toContain("return openDraftByIdentity(settlementDecision.identity, signal)");
    expect(settlement).toContain("decideSettledDraftFetch(");
  });

  it("is Draft-only and never enters Inbox/Sent", () => {
    const src = route();
    const staleGate = src.slice(
      src.indexOf("const staleDraftIdentity ="),
      src.indexOf("const fetchUid = parsed.uid;"),
    );
    expect(staleGate).toContain('parsed.folder === "drafts"');
    expect(staleGate).not.toContain('"inbox"');
    expect(staleGate).not.toContain('"sent"');
  });

  it("leaves the visible Draft row in place during redirect", () => {
    const src = route();
    const staleRedirect = src.slice(
      src.indexOf("const staleDraftIdentity ="),
      src.indexOf("const fetchUid = parsed.uid;"),
    );
    expect(staleRedirect).not.toContain("setMessages((prev) => prev.filter");
    expect(staleRedirect).not.toContain("hideRow(");
  });

  it("still protects a current just-saved Y real NOT_FOUND", () => {
    const src = route();
    const notFound = src.slice(
      src.indexOf("const protectedDraft ="),
      src.indexOf('if (parsed.folder !== "all")'),
    );
    expect(notFound).toContain("recoverJustSavedDraft(");
    expect(notFound).toContain("savedDraftGuardRef.current?.find(");
  });
});
