import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ConversationRow } from "@/lib/mail-conversation.functions";
import {
  INITIAL_CONVERSATION_HISTORY_LIMIT,
  prepareConversationHistory,
} from "@/lib/mail-conversation-history";

function row(uid: number, date = new Date(uid * 1_000).toISOString()): ConversationRow {
  return {
    uid,
    folder: "inbox",
    uidValidity: "9",
    subject: `message ${uid}`,
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "Recipient", email: "recipient@example.com" }],
    date,
    seen: true,
    flagged: false,
    hasAttachments: false,
    messageId: `<${uid}@example.com>`,
  };
}

function selected(uid: number, date = new Date(uid * 1_000).toISOString()) {
  return { id: `inbox:${uid}`, uidValidity: "9", date };
}

describe("bounded previous-message preparation", () => {
  for (const size of [1, 2, 24, 25, 26, 30, 50, 100]) {
    it(`selects a correct bounded window for ${size} conversation messages`, () => {
      const rows = Array.from({ length: size }, (_, index) => row(index + 1));
      const latest = prepareConversationHistory(rows, selected(size));
      expect(latest.map((item) => item.uid)).toEqual(
        rows
          .slice(Math.max(0, size - 1 - INITIAL_CONVERSATION_HISTORY_LIMIT), size - 1)
          .reverse()
          .map((item) => item.uid),
      );

      const middleUid = Math.max(1, Math.ceil(size / 2));
      const middle = prepareConversationHistory(rows, selected(middleUid));
      expect(middle.every((item) => item.uid < middleUid)).toBe(true);
      expect(middle[0]?.uid).toBe(middleUid > 1 ? middleUid - 1 : undefined);
      expect(prepareConversationHistory(rows, selected(1))).toEqual([]);
    });
  }

  it("never labels newer messages as previous and removes the selected row", () => {
    const rows = [row(1), row(2), row(3), row(4), row(5)];
    expect(prepareConversationHistory(rows, selected(3)).map((item) => item.uid)).toEqual([2, 1]);
  });

  it("deduplicates physical rows and keeps deterministic same-timestamp order", () => {
    const date = "2026-08-12T10:00:00.000Z";
    const rows = [row(2, date), row(1, date), row(2, date), row(3, date)];
    const first = prepareConversationHistory(rows, selected(4, date));
    const second = prepareConversationHistory([...rows].reverse(), selected(4, date));
    expect(first.map((item) => item.uid)).toEqual([3, 2, 1]);
    expect(second.map((item) => item.uid)).toEqual([3, 2, 1]);
  });

  it("keeps distinct physical copies and does not dedupe by Message-ID", () => {
    const first = row(1);
    const second = { ...row(2), messageId: first.messageId };
    expect(prepareConversationHistory([first, second], selected(3))).toHaveLength(2);
  });

  it("keeps the request graph bounded and scopes late responses to the active session", () => {
    const route = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
    const hook = route.slice(
      route.indexOf("function useConversationRows("),
      route.indexOf("function ConversationHistory("),
    );
    expect(hook.match(/listConversation\(\{/g)).toHaveLength(1);
    expect(hook).toContain("mailSessionToken");
    expect(hook).toContain("sessionScope");
    expect(hook).toContain("[mailSessionToken, messageId, listConversation, sessionScope]");
    expect(hook).toContain("if (!cancelled) setRows");
    expect(hook).not.toMatch(/openMailMessage\(|fetchMessage\(|bridge[A-Z]|inlineImages/);
  });
});
