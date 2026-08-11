import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MailMessage } from "@/lib/mail-types";
import { mergeSenderMessagePages } from "@/lib/mail-sender-folders.functions";

function message(uid: number, date = uid): MailMessage {
  return {
    id: `inbox:${uid}`,
    threadId: `thread:${uid}`,
    folder: "inbox",
    from: { name: "Sender", email: "sender@example.com" },
    to: [],
    subject: `Message ${uid}`,
    preview: "",
    body: "",
    date: new Date(1_700_000_000_000 + date * 1000).toISOString(),
    read: false,
    starred: false,
    hasAttachments: false,
  };
}

const routeSource = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../../../bridge/src/imap.ts", import.meta.url), "utf8");
const bridgeIndexSource = readFileSync(
  new URL("../../../bridge/src/index.ts", import.meta.url),
  "utf8",
);
const serverFunctionSource = readFileSync(
  new URL("../mail-bridge.functions.ts", import.meta.url),
  "utf8",
);

describe("sender-folder Local Index to IMAP handoff", () => {
  it("keeps all 135 indexed rows reachable as 50 + 50 + 35 without dedupe loss", () => {
    const rows = Array.from({ length: 135 }, (_, index) => message(135 - index));
    let rendered: MailMessage[] = [];
    const pageSizes: number[] = [];
    for (let offset = 0; offset < rows.length; offset += 50) {
      const page = rows.slice(offset, offset + 50);
      pageSizes.push(page.length);
      rendered = mergeSenderMessagePages(rendered, page);
    }
    expect(pageSizes).toEqual([50, 50, 35]);
    expect(rendered).toHaveLength(135);
  });

  it("deduplicates Local Index overlap while preserving newest-first order", () => {
    const indexed = Array.from({ length: 50 }, (_, index) => message(100 - index));
    const server = Array.from({ length: 50 }, (_, index) => message(95 - index));
    const merged = mergeSenderMessagePages(indexed, server);
    expect(merged).toHaveLength(55);
    expect(merged.map((row) => Number(row.id.split(":")[1]))).toEqual(
      Array.from({ length: 55 }, (_, index) => 100 - index),
    );
  });

  it("does not infer exhaustion from a fully overlapping page", () => {
    const current = Array.from({ length: 50 }, (_, index) => message(100 - index));
    const overlap = current.slice();
    expect(mergeSenderMessagePages(current, overlap)).toHaveLength(50);
    expect(routeSource).toContain("history.exhausted = !deep.hasMore");
    expect(routeSource).not.toContain("history.exhausted = extra.length === 0");
  });
});

describe("sender-history orchestration safety", () => {
  it("does zero historical work during initial sender-folder load", () => {
    const initialLoad = routeSource.slice(
      routeSource.indexOf("const loadMessages = useCallback"),
      routeSource.indexOf("const loadMore = useCallback"),
    );
    expect(initialLoad).toContain("listSender({");
    expect(initialLoad).not.toContain("getSenderHistoryPage({");
  });

  it("starts Tier 2 only inside explicit loadMore after the Local Index cursor ends", () => {
    const loadMore = routeSource.slice(
      routeSource.indexOf("const loadMore = useCallback"),
      routeSource.indexOf("// Counts on mount"),
    );
    expect(loadMore).toMatch(
      /if \(senderView\)[\s\S]*if \(!senderCursor\)[\s\S]*getSenderHistoryPage\(\{/,
    );
    expect(loadMore).toContain("setSenderCursor(res.nextCursor)");
  });

  it("guards duplicate requests and sender/account/generation stale responses", () => {
    expect(routeSource).toContain("senderHistoryFlightRef.current === flightKey");
    expect(routeSource).toContain("loadReqIdRef.current !== requestGeneration");
    expect(routeSource).toContain("senderScopeKeyRef.current !== scopeKey");
    expect(routeSource).toContain("session.account.id");
  });

  it("scopes historical loading so stale sender/account work cannot block the active view", () => {
    expect(routeSource).toContain("setSenderHistoryLoadingScope(scopeKey)");
    expect(routeSource).toContain("current === scopeKey ? null : current");
    expect(routeSource).toContain("senderHistoryLoadingScope === senderScopeKey");
    expect(routeSource).toContain("if (!historicalScope) setLoadingMore(true)");
    expect(routeSource).toContain("if (!historicalScope) setLoadingMore(false)");
  });

  it("preserves the cursor and retryability after a failed historical page", () => {
    const historicalBlock = routeSource.slice(
      routeSource.indexOf("const flightKey ="),
      routeSource.indexOf("const res = await listSender", routeSource.indexOf("const flightKey =")),
    );
    const cursorAssignment = historicalBlock.indexOf("history.cursor = deep.nextCursor");
    const catchBlock = historicalBlock.indexOf("} catch {");
    expect(cursorAssignment).toBeGreaterThan(0);
    expect(catchBlock).toBeGreaterThan(cursorAssignment);
    expect(historicalBlock.slice(catchBlock)).toContain("setHasMore(true)");
    expect(historicalBlock.slice(catchBlock)).not.toContain("history.cursor =");
  });

  it("leaves generic Search intact and does not use it for sender history", () => {
    expect(routeSource).toContain("const searchFn = useMailServerFn(bridgeSearch)");
    expect(routeSource).not.toContain("const searchSender = useMailServerFn(bridgeSearch)");
    expect(bridgeSource).toContain("export async function searchMessages(");
    expect(bridgeSource).toContain("orChain(branches)");
  });

  it("fetches metadata only and never body/source/attachment bytes", () => {
    const senderOperation = bridgeSource.slice(
      bridgeSource.indexOf("export async function getSenderMessagesPageInMailbox"),
      bridgeSource.indexOf("export async function getSenderMessagesPage("),
    );
    expect(senderOperation).toContain("envelope: true");
    expect(senderOperation).toContain("bodyStructure: true");
    expect(senderOperation).not.toMatch(/bodyParts|source: true|download\(/);
  });

  it("uses bounded PARTIAL results with a bounded session-local fallback cache", () => {
    expect(bridgeSource).toContain("returnOptions: [{ partial: `-1:-${candidateLimit}` }]");
    expect(bridgeSource).toContain("const candidateLimit = boundedLimit + 1");
    expect(bridgeSource).toContain("SENDER_HISTORY_CACHE_MAX_ENTRIES = 32");
    expect(bridgeSource).toContain("SENDER_HISTORY_CACHE_MAX_UIDS = 100_000");
    expect(bridgeSource).toContain("SENDER_HISTORY_CACHE_TTL_MS = 2 * 60_000");
  });

  it("uses one protected, lower-priority dedicated endpoint", () => {
    expect(bridgeIndexSource).toContain(
      'app.post("/api/sender-messages", requireKey, imapGate("background")',
    );
    expect(serverFunctionSource).toContain('"/api/sender-messages"');
    expect(serverFunctionSource).toContain("resolveBridgeAuth(mailSessionToken)");
    expect(bridgeSource.match(/export async function getSenderMessagesPage\(/g)).toHaveLength(1);
  });
});
