import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");
const messageBody = source.slice(
  source.indexOf("function MessageBody("),
  source.indexOf("import {", source.indexOf("function MessageBody(")),
);
const historicalCard = source.slice(
  source.indexOf("function ConversationMessageCard("),
  source.indexOf("function useConversationRows("),
);
const currentView = source.slice(
  source.indexOf("function MessageView("),
  source.indexOf("function EmptyViewer("),
);

describe("MAILMAESTRO message render CPU", () => {
  it("sanitizes once per physical message identity and body", () => {
    expect(messageBody).toContain(
      "const sanitizedHtml = useMemo(() => {",
    );
    expect(messageBody).toContain("void bodyIdentity");
    expect(messageBody).toContain("html={sanitizedHtml}");
    expect(messageBody.match(/sanitizeEmailHtml\(/g)).toHaveLength(1);
  });

  it("does not sanitize again for CID or unrelated state changes", () => {
    expect(messageBody).toContain("[bodyIdentity, html]");
    expect(messageBody.match(/sanitizeEmailHtml\(/g)).toHaveLength(1);
  });

  it("re-sanitizes on body or identity changes and cannot reuse stale HTML", () => {
    expect(messageBody).toContain(
      'const bodyIdentity = `${message.id}|${message.uidValidity ?? ""}`',
    );
    expect(messageBody).toContain("[bodyIdentity, html]");
  });

  it("historical rendering delegates one quoted split to ThreadedEmailBody", () => {
    expect(historicalCard).toContain('html={loaded.body || loaded.preview || ""}');
    expect(historicalCard).not.toContain("splitQuotedHtml(");
    expect(historicalCard).not.toContain("sanitizeEmailHtml(");
    expect(messageBody).toContain("<ThreadedEmailBody");
  });

  it("normal and historical messages share the same MessageBody pipeline", () => {
    expect(currentView).toContain("<MessageBody");
    expect(currentView).toContain('html={message.body || message.preview || ""}');
    expect(historicalCard).toContain("<MessageBody");
  });
});
