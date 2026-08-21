import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createNormalComposeMessageId,
  isNormalSendId,
} from "@/lib/mail-normal-send-idempotency";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("normal compose durable send idempotency", () => {
  it("derives one stable Message-ID from the logical send id", () => {
    const sendId = "123e4567-e89b-42d3-a456-426614174000";
    expect(isNormalSendId(sendId)).toBe(true);
    expect(createNormalComposeMessageId(sendId, "user@example.com")).toBe(
      "<mailmaestro.compose.123e4567-e89b-42d3-a456-426614174000@example.com>",
    );
    expect(createNormalComposeMessageId(sendId, "user@example.com")).toBe(
      createNormalComposeMessageId(sendId, "user@example.com"),
    );
    expect(createNormalComposeMessageId(sendId, "invalid")).toContain("@mailmaestro.local>");
  });

  it("claims in DB before SMTP and never automatically reclaims sending", () => {
    const server = read("src/lib/mail-normal-send.server.ts");
    const sql = read("supabase/migrations/20260822020000_mail_normal_send_idempotency.sql");

    expect(server).toContain('db().rpc("claim_mail_normal_send"');
    expect(server).toContain('db().rpc("mark_mail_normal_send_in_flight"');
    expect(server).toContain("/api/send-reconcile");
    expect(server).toContain("if (!input.confirmResendUnknown)");
    expect(server).toContain("reclaim_mail_normal_send_after_unknown");
    expect(server).toContain("retainClientHandlesOnSuccess: true");
    expect(sql).toContain("UNIQUE (send_id, company_id, account_id)");
    expect(sql).toContain("A 30-second propagation window mirrors the Working");
    expect(sql).toContain("s.updated_at <= now() - interval '30 seconds'");
  });

  it("wires the browser send id and explicit resend confirmation through the trusted route", () => {
    const mail = read("src/routes/mail.tsx");
    const route = read("src/routes/api/mail-send-v2.ts");
    const bridge = read("bridge/src/index.ts");

    expect(mail).toContain("sendId: draftId");
    expect(mail).toContain('result.code === "SEND_OUTCOME_UNKNOWN"');
    expect(mail).toContain("...normalSendRequestBody");
    expect(mail).toContain("confirmResendUnknown: true");
    expect(route).toContain("sendNormalCompose");
    expect(route).toContain("confirmResendUnknown: body.confirmResendUnknown === true");
    expect(bridge).toContain("retainClientHandlesOnSuccess");
    expect(bridge).toContain(
      "sendSucceeded: sendSucceeded && !retainClientHandlesOnSuccess",
    );
  });

  it("uses one DB advisory-lock domain across normal Compose and Working Draft", () => {
    const sql = read("supabase/migrations/20260822020000_mail_normal_send_idempotency.sql");

    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.claim_mail_normal_send");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.save_mail_working_draft");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_send");
    expect(sql).toContain("'mailmaestro-working-draft:'");
    expect((sql.match(/pg_advisory_xact_lock/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(sql).toContain("NORMAL_SEND_PROMOTED");
    expect(sql).toContain("NORMAL_SEND_ACTIVE");
    expect(sql).toContain("HANDOFF_TO_WORKING_DRAFT");
  });

  it("reconciles or explicitly hands a normal attempt to Working Draft before SMTP", () => {
    const server = read("src/lib/mail-working-draft.server.ts");
    const sql = read("supabase/migrations/20260822020000_mail_normal_send_idempotency.sql");

    expect(server).toContain("guardWorkingDraftAgainstPriorNormalSend");
    expect(server).toContain('db().rpc("handoff_mail_normal_send_to_working_draft"');
    expect(server).toContain('claim.error === "NORMAL_SEND_ACTIVE"');
    expect(server).toContain("finishCrossPathSent");
    expect(server).toContain("if (!input.confirmResendUnknown) return { kind: \"unknown\" }");
    expect(sql).toContain("handoff_mail_normal_send_to_working_draft");
    expect(sql).toContain("mark_mail_normal_send_handoff_sent");
    expect(sql).toContain("current_normal.error = 'HANDOFF_TO_WORKING_DRAFT'");
  });
});
