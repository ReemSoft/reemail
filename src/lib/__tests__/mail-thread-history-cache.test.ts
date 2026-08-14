import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageMemoryCache } from "../mail-message-memory-cache";
import type { MailFolder, MailMessage } from "../mail-types";

const source = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");
const fetchBlock = source.slice(
  source.indexOf("const fetchMessage"),
  source.indexOf("const prefetchQueueRef"),
);
const cardBlock = source.slice(
  source.indexOf("function ConversationMessageCard"),
  source.indexOf("function useConversationRows"),
);
const historyBlock = source.slice(
  source.indexOf("function ConversationHistory"),
  source.indexOf("function MessageView"),
);
const scope = { companyId: "company-1", accountId: "account-1" };

function message(
  folder: MailFolder,
  uid: number,
  uidValidity = "7",
  body = `${folder}-body`,
): MailMessage {
  return {
    id: `${folder}:${uid}`,
    threadId: `thread-${uid}`,
    uidValidity,
    folder,
    from: { name: "Sender", email: "sender@example.test" },
    to: [],
    subject: "Subject",
    preview: "Preview",
    body,
    date: "2026-01-01T00:00:00.000Z",
    read: false,
    starred: false,
    hasAttachments: false,
  };
}

describe("MAILMAESTRO historical thread body cache", () => {
  it("returns a historical memory hit without calling openMailMessage", () => {
    const cache = new MessageMemoryCache();
    const sent = message("sent", 10);
    cache.set(scope, sent);
    let opens = 0;
    const result = cache.get(scope, sent) ?? (opens++, null);
    expect(result?.body).toBe("sent-body");
    expect(opens).toBe(0);
    expect(cardBlock).not.toContain("useMailServerFn(openMailMessage)");
  });

  it("uses one shared Server Function on a memory miss with a persistent-cache result", () => {
    expect(fetchBlock.match(/const p = openMsg\(/g)).toHaveLength(1);
    expect(fetchBlock).toContain('source: result.ok && result.source === "cache" ? "server-cache"');
    expect(fetchBlock).toContain("messageMemoryRef.current?.set(scope, patched)");
  });

  it("stores an IMAP result in the same MessageMemoryCache", () => {
    expect(fetchBlock).toContain('result.ok && result.source === "imap"');
    expect(fetchBlock).toContain("messageMemoryRef.current?.set(scope, patched)");
  });

  it("shares one underlying request for concurrent opens of the same physical message", () => {
    expect(fetchBlock).toContain("const existing = inflight.current.get(requestKey)");
    expect(fetchBlock).toContain("return existing.promise");
    expect(fetchBlock).toContain(
      "inflight.current.set(requestKey, { promise: p, controller, lane })",
    );
    expect(fetchBlock).toContain("context: MessageOpenContext");
  });

  it("keeps persistent cache usable when the historical row is absent from messagesRef", () => {
    expect(fetchBlock).toContain(
      "const base = suppliedBase ?? messagesRef.current.find((m) => m.id === id) ?? null",
    );
    expect(fetchBlock).toContain("allowCache: base != null");
  });

  it("uses the historical physical folder identity across folders", () => {
    const cache = new MessageMemoryCache();
    const sent = message("sent", 11);
    cache.set(scope, sent);
    expect(cache.get(scope, sent)?.id).toBe("sent:11");
    expect(fetchBlock).toContain("suppliedIdentity.folder !== parsed.folder");
  });

  it("does not collide when Inbox and Sent have the same UID", () => {
    const cache = new MessageMemoryCache();
    const inbox = message("inbox", 12, "7", "inbox");
    const sent = message("sent", 12, "7", "sent");
    cache.set(scope, inbox);
    cache.set(scope, sent);
    expect(cache.get(scope, inbox)?.body).toBe("inbox");
    expect(cache.get(scope, sent)?.body).toBe("sent");
  });

  it("does not reuse a historical entry across UIDVALIDITY", () => {
    const cache = new MessageMemoryCache();
    cache.set(scope, message("archive", 13, "7", "old"));
    expect(cache.get(scope, message("archive", 13, "8"))).toBeNull();
    expect(fetchBlock).toContain("returnedUidValidity !== uidValidity");
  });

  it("does not reuse a historical entry across accounts", () => {
    const cache = new MessageMemoryCache();
    const row = message("inbox", 14);
    cache.set(scope, row);
    expect(cache.get({ ...scope, accountId: "account-2" }, row)).toBeNull();
  });

  it("does not reuse a historical entry across companies", () => {
    const cache = new MessageMemoryCache();
    const row = message("inbox", 15);
    cache.set(scope, row);
    expect(cache.get({ ...scope, companyId: "company-2" }, row)).toBeNull();
  });

  it("keeps a loaded card body across collapse and reopen", () => {
    expect(cardBlock).toMatch(/if \(open\) \{\s*setOpen\(false\);\s*return;/);
    expect(cardBlock).toContain('if (loaded || state === "loading") return');
  });

  it("makes historical NOT_FOUND free of current-list cleanup side effects", () => {
    expect(fetchBlock).toContain('lane === "background" || context.kind === "historical"');
    const historicalGuard = fetchBlock.indexOf(
      'lane === "background" || context.kind === "historical"',
    );
    const cleanup = fetchBlock.indexOf("void cleanupGhost(");
    expect(historicalGuard).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(historicalGuard);
    expect(source).toContain(
      "isMessageSuppressed(pendingMovesRef.current, currentAccountId, base.id)",
    );
  });

  it("leaves normal-open memory-hit behavior unchanged", () => {
    expect(source).toMatch(
      /const cached = messageCache\.current\.get\(id\);[\s\S]{0,500}if \(cached\) \{/,
    );
    expect(source).toContain('source: "memory" } as ClientMessageResult');
  });

  it("leaves normal cold opening on the default current-list policy", () => {
    expect(fetchBlock).toContain('context: MessageOpenContext = { kind: "current-list" }');
    expect(source).toContain(': await fetchMessage(id, "interactive", undefined,');
  });

  it("keeps hover prefetch while batching visible/adjacent windows", () => {
    expect(source).toContain("const result = await fetchMessage(id, lane, signal)");
    expect(source).toContain('prefetchMessage(id, "hover"');
    expect(source).toContain("void prefetchWindow([selectedId, ...ids].slice(0, 10))");
  });

  it("preserves account and company privacy clearing", () => {
    expect(source).toContain("resetAsyncScope(identityChanged)");
    expect(source).toContain("if (identityChanged)");
    expect(source).toContain("messageCache.current.clear()");
  });

  it("preserves valid completed cache entries across folder switches", () => {
    const scopeEffect = source.slice(
      source.indexOf("// Folder switches cancel speculative work"),
      source.indexOf("// Clear deep search results"),
    );
    expect(scopeEffect).toContain("resetAsyncScope(identityChanged)");
    expect(scopeEffect).not.toContain("resetAsyncScope(true)");
  });

  it("does not request historical bodies while rendering ConversationHistory", () => {
    expect(historyBlock).toContain("<ConversationMessageCard");
    expect(historyBlock).not.toContain("openMailMessage(");
    expect(historyBlock).not.toContain("onOpenHistorical(row)");
    expect(cardBlock).toMatch(
      /async function toggle\(\)[\s\S]*const attempt = onOpenHistorical\(row\)/,
    );
  });
});
