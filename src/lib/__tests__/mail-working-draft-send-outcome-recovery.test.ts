import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("working draft ambiguous Send recovery", () => {
  it("persists a stable Message-ID before SMTP and reconciles Sent read-only", () => {
    const server = read("src/lib/mail-working-draft.server.ts");
    const bridge = read("bridge/src/index.ts");
    const smtp = read("bridge/src/smtp.ts");
    const mime = read("bridge/src/mime-spool.ts");

    expect(server).toContain("createWorkingDraftMessageId");
    expect(server).toContain("p_message_id: messageId");
    expect(server).toContain('bridge.bridgeUrl}/api/send-reconcile');
    expect(server).toMatch(/messageId,\r?\n\s+payload: record\.payload/);
    expect(bridge).toContain('app.post("/api/send-reconcile"');
    expect(bridge).toContain('imapGate("background")');
    expect(bridge).toContain("messageId: payload.messageId");
    expect(smtp).toContain("export async function reconcileSentMessage");
    expect(mime).toContain("payload.messageId ? { messageId: payload.messageId }");
  });

  it("never automatically reclaims sending and requires explicit user confirmation", () => {
    const server = read("src/lib/mail-working-draft.server.ts");
    const api = read("src/routes/api/mail-working-draft-send.ts");
    const mail = read("src/routes/mail.tsx");
    const state = read("src/lib/mail-working-draft-send-idempotency.ts");
    const sql = read(
      "supabase/migrations/20260821191500_working_draft_send_outcome_recovery.sql",
    );

    expect(state).toContain("never reclaimed automatically");
    expect(server).toContain("if (!input.confirmResendUnknown)");
    expect(server).toContain('throw new Error("SEND_OUTCOME_UNKNOWN")');
    expect(api).toContain("confirmResendUnknown");
    expect(mail).toContain("window.confirm");
    expect(mail).toContain("confirmResendUnknown: true");
    expect(sql).toContain("reclaim_mail_working_draft_send_after_unknown");
    expect(sql).toContain("p_expected_revision");
    expect(sql).toContain("smtp_result ->> 'messageId' = p_message_id");
    expect(sql).toContain("p_message_id IS NULL\n        AND smtp_result IS NULL");
  });
});
