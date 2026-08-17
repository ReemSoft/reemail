import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  isDefinitePreSmtpSendError,
  nextWorkingDraftSendClaim,
  type WorkingDraftSendAttempt,
} from "../mail-working-draft-send-idempotency";

const MIGRATION = readFileSync(
  new URL(
    "../../../supabase/migrations/20260817080000_mail_working_draft_sends.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("mail_working_draft_sends migration", () => {
  it("defines the durable tenant-owned send-attempt table", () => {
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS public.mail_working_draft_sends");
    expect(MIGRATION).toContain("state text NOT NULL DEFAULT 'preparing'");
    expect(MIGRATION).toContain("CHECK (state IN ('preparing', 'sending', 'sent', 'failed'))");
    expect(MIGRATION).toContain("UNIQUE (draft_id, company_id, account_id)");
    expect(MIGRATION).toContain("FOREIGN KEY (account_id, company_id)");
  });

  it("denies client access and grants service_role only", () => {
    expect(MIGRATION).toContain("ENABLE ROW LEVEL SECURITY");
    expect(MIGRATION).toContain("REVOKE ALL ON public.mail_working_draft_sends FROM anon, authenticated");
    expect(MIGRATION).toContain("GRANT ALL ON public.mail_working_draft_sends TO service_role");
  });

  it("exposes claim/sent/failed RPCs with service_role grants", () => {
    expect(MIGRATION).toContain("claim_mail_working_draft_send");
    expect(MIGRATION).toContain("mark_mail_working_draft_send_in_flight");
    expect(MIGRATION).toContain("mark_mail_working_draft_send_sent");
    expect(MIGRATION).toContain("mark_mail_working_draft_send_failed");
    expect(MIGRATION).toContain("FOR UPDATE");
    expect(MIGRATION).toContain("ON CONFLICT (draft_id, company_id, account_id) DO NOTHING");
    expect(MIGRATION).toContain(
      "GRANT EXECUTE ON FUNCTION public.claim_mail_working_draft_send(uuid, uuid, uuid)",
    );
  });

  it("returns claimed=true for a brand-new insert instead of re-reading it as preparing", () => {
    expect(MIGRATION).toContain("RETURNING id INTO inserted_id;");
    expect(MIGRATION).toContain("IF inserted_id IS NOT NULL THEN");
    expect(MIGRATION).toContain("RETURN QUERY SELECT true, 'preparing'::text, NULL::jsonb, NULL::text;");
  });
});

describe("Working Draft send idempotency state flow", () => {
  const now = 1_000_000;
  const leaseMs = 10 * 60_000;

  it("first claim on a nonexistent send record returns claimed=true", () => {
    expect(nextWorkingDraftSendClaim({ attempt: null, now, leaseMs })).toEqual({
      claimed: true,
      state: "preparing",
    });
  });

  it("concurrent first claims allow exactly one caller to receive claimed=true", () => {
    let attempt: WorkingDraftSendAttempt | null = null;
    const first = nextWorkingDraftSendClaim({ attempt, now, leaseMs });
    expect(first.claimed).toBe(true);

    attempt = { state: "preparing", leaseUntil: now + leaseMs };
    const second = nextWorkingDraftSendClaim({ attempt, now: now + 1, leaseMs });
    expect(second).toEqual({ claimed: false, state: "preparing" });
  });

  it("claims a new attempt and invokes SMTP exactly once", () => {
    const send = vi.fn(() => ({ ok: true, messageId: "m-1" }));
    let attempt: WorkingDraftSendAttempt | null = null;

    const claim = nextWorkingDraftSendClaim({ attempt, now, leaseMs });
    expect(claim).toEqual({ claimed: true, state: "preparing" });
    if (claim.claimed) {
      attempt = { state: "preparing", leaseUntil: now + leaseMs };
      // Immediately before SMTP, the server atomically transitions to sending.
      attempt = { state: "sending", leaseUntil: null };
      send();
    }

    const concurrent = nextWorkingDraftSendClaim({ attempt, now: now + 1, leaseMs });
    expect(concurrent).toEqual({ claimed: false, state: "sending" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns the stored result after SMTP acceptance without calling SMTP again", () => {
    const send = vi.fn();
    const attempt: WorkingDraftSendAttempt = { state: "sent", leaseUntil: null };
    const claim = nextWorkingDraftSendClaim({ attempt, now, leaseMs });
    expect(claim).toEqual({ claimed: false, state: "sent" });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows a safe retry after a failure before SMTP acceptance", () => {
    const attempt: WorkingDraftSendAttempt = { state: "failed", leaseUntil: null };
    const claim = nextWorkingDraftSendClaim({ attempt, now, leaseMs });
    expect(claim).toEqual({ claimed: true, state: "preparing" });
  });

  it("does not reclaim an in-flight/ambiguous sending attempt", () => {
    const attempt: WorkingDraftSendAttempt = { state: "sending", leaseUntil: null };
    expect(nextWorkingDraftSendClaim({ attempt, now: now + 10 * leaseMs, leaseMs })).toEqual({
      claimed: false,
      state: "sending",
    });
  });

  it("reclaims a stale/crashed preparing attempt before SMTP", () => {
    const attempt: WorkingDraftSendAttempt = {
      state: "preparing",
      leaseUntil: now - 1,
    };
    expect(nextWorkingDraftSendClaim({ attempt, now, leaseMs })).toEqual({
      claimed: true,
      state: "preparing",
    });
  });
});

describe("pre-SMTP rejection classification", () => {
  it("treats known validation/staging failures as definitely pre-SMTP", () => {
    expect(isDefinitePreSmtpSendError("INVALID_PAYLOAD")).toBe(true);
    expect(isDefinitePreSmtpSendError("ATTACHMENT_KIND_MISMATCH")).toBe(true);
    expect(isDefinitePreSmtpSendError("ATTACHMENTS_TOO_LARGE")).toBe(true);
    expect(isDefinitePreSmtpSendError("SEND_BUSY")).toBe(true);
  });

  it("treats SMTP transport errors and unknown errors as ambiguous", () => {
    expect(isDefinitePreSmtpSendError("Failed to send message")).toBe(false);
    expect(isDefinitePreSmtpSendError("ECONNRESET")).toBe(false);
    expect(isDefinitePreSmtpSendError(undefined)).toBe(false);
  });
});
