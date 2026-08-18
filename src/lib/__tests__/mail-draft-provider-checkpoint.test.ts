import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS,
  coalesceLatestProviderCheckpoint,
  isDraftProviderCheckpointFenced,
  shouldRunProviderCheckpoint,
} from "../mail-draft-provider-checkpoint";

describe("Draft provider checkpoint cadence", () => {
  it("uses 5 minutes / 300000 ms", () => {
    expect(DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS).toBe(300_000);
  });

  it("does not run an unchanged Draft", () => {
    expect(
      shouldRunProviderCheckpoint({
        latestWorkingRevision: 11,
        lastCheckpointedRevision: 11,
      }),
    ).toBe(false);
  });

  it("runs only when Working Draft has advanced", () => {
    expect(
      shouldRunProviderCheckpoint({
        latestWorkingRevision: 12,
        lastCheckpointedRevision: 11,
      }),
    ).toBe(true);
  });
});

describe("latest-wins coalescing", () => {
  it("coalesces revisions 11..14 into revision 14 while 10 is running", () => {
    expect(
      coalesceLatestProviderCheckpoint({
        runningRevision: 10,
        latestRequestedRevision: 14,
      }),
    ).toBe(14);
  });

  it("does not schedule a follow-up when the latest revision is already running", () => {
    expect(
      coalesceLatestProviderCheckpoint({
        runningRevision: 14,
        latestRequestedRevision: 14,
      }),
    ).toBeNull();
  });
});

describe("provider checkpoint send fence", () => {
  it("fences checkpoint for sent and ambiguous sending states", () => {
    expect(isDraftProviderCheckpointFenced("sent")).toBe(true);
    expect(isDraftProviderCheckpointFenced("sending")).toBe(true);
    expect(isDraftProviderCheckpointFenced("preparing")).toBe(false);
    expect(isDraftProviderCheckpointFenced("failed")).toBe(false);
    expect(isDraftProviderCheckpointFenced(null)).toBe(false);
  });
});

describe("provider checkpoint production wiring", () => {
  const server = () =>
    readFileSync(new URL("../mail-working-draft.server.ts", import.meta.url), "utf8");
  const mail = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
  const migration = () =>
    readFileSync(
      new URL(
        "../../../supabase/migrations/20260818120000_atomic_working_draft_checkpoint_finalize.sql",
        import.meta.url,
      ),
      "utf8",
    );
  const claimMigration = () =>
    readFileSync(
      new URL(
        "../../../supabase/migrations/20260817070000_mail_working_drafts.sql",
        import.meta.url,
      ),
      "utf8",
    );

  it("checks durable send state before and after APPEND", () => {
    const src = server();
    expect(src).toContain("getWorkingDraftSendState");
    expect(src).toContain("isDraftProviderCheckpointFenced(preSendState)");
    expect(src).toContain("finishWorkingDraftCheckpointIfActive");
  });

  it("never publishes a late-after-send provider UID", () => {
    const src = server();
    expect(src).toContain('return { ok: true, skipped: true, fenced: true };');
    expect(src).toContain("deleteProviderDraftExplicit({");
  });

  it("uses the atomic finalize RPC after APPEND", () => {
    const src = server();
    expect(src).toContain("finishWorkingDraftCheckpointIfActive");
    expect(src).toContain("finish_mail_working_draft_checkpoint_if_active");
  });

  it("atomic finalizer fences both sending and sent atomically", () => {
    const src = migration();
    expect(src).toContain("CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_checkpoint_if_active");
    expect(src).toContain("FOR UPDATE");
    expect(src).toContain("state IN ('sending', 'sent')");
    expect(src).toContain("RETURN QUERY SELECT false, true, send_row.state");
  });

  it("suppresses provider rows while sending but keeps logical Working Draft visible", () => {
    const src = server();
    expect(src).toContain("sendingProviderRefs");
    expect(src).toContain("state\", \"sending");
    expect(src).toContain("filterSentWorkingDraftRecords(records, sentIds)");
  });

  it("Send does not wait for provider checkpoint", () => {
    const src = mail();
    expect(src).not.toContain("await (workingCheckpointFlightRef.current");
    expect(src).toContain("phase=provider-checkpoint-not-awaited");
  });

  it("send/discard cancel future provider checkpoint scheduling", () => {
    const src = mail();
    expect(src).toContain("workingCheckpointPendingRef.current = false;");
    expect(src).toContain("workingCheckpointTimerRef.current !== null");
  });

  it("explicit Save/Close request expedited background checkpoint without awaiting", () => {
    const src = mail();
    expect(src).toContain("scheduleWorkingDraftCheckpoint(hasAttachments, true)");
  });
});

describe("shared logical Draft advisory lock", () => {
  const server = () =>
    readFileSync(new URL("../mail-working-draft.server.ts", import.meta.url), "utf8");
  const migration = () =>
    readFileSync(
      new URL(
        "../../../supabase/migrations/20260818120000_atomic_working_draft_checkpoint_finalize.sql",
        import.meta.url,
      ),
      "utf8",
    );
  const claimMigration = () =>
    readFileSync(
      new URL(
        "../../../supabase/migrations/20260817070000_mail_working_drafts.sql",
        import.meta.url,
      ),
      "utf8",
    );

  const lockKey =
    "'mailmaestro-working-draft:' ||\n      p_company_id::text || ':' ||\n      p_account_id::text || ':' ||\n      p_draft_id::text";

  it("all five RPCs use the same pg_advisory_xact_lock key", () => {
    const src = migration();
    expect(src.match(/pg_advisory_xact_lock\(/g)).toHaveLength(5);
    expect(src.match(/pg_advisory_lock\(/g)).toBeNull();
    expect(src.split(lockKey).length - 1).toBe(5);
  });

  it("claim RPC acquires the advisory lock before INSERT", () => {
    const src = migration();
    const start = src.indexOf("CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_send");
    const end = src.indexOf("CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_in_flight", start);
    const fn = src.slice(start, end);
    expect(fn.indexOf("pg_advisory_xact_lock(")).toBeGreaterThan(-1);
    expect(fn.indexOf("pg_advisory_xact_lock(")).toBeLessThan(fn.indexOf("INSERT INTO public.mail_working_draft_sends"));
  });

  it("in-flight RPC acquires the advisory lock before UPDATE", () => {
    const src = migration();
    const start = src.indexOf("CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_in_flight");
    const end = src.indexOf("CREATE OR REPLACE FUNCTION public.mark_mail_working_draft_send_sent", start);
    const fn = src.slice(start, end);
    expect(fn.indexOf("pg_advisory_xact_lock(")).toBeGreaterThan(-1);
    expect(fn.indexOf("pg_advisory_xact_lock(")).toBeLessThan(fn.indexOf("UPDATE public.mail_working_draft_sends"));
  });

  it("sent and failed RPCs acquire the advisory lock before UPDATE", () => {
    const src = migration();
    for (const name of [
      "mark_mail_working_draft_send_sent",
      "mark_mail_working_draft_send_failed",
    ]) {
      const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
      const fn = src.slice(start);
      expect(fn.indexOf("pg_advisory_xact_lock(")).toBeGreaterThan(-1);
      expect(fn.indexOf("pg_advisory_xact_lock(")).toBeLessThan(fn.indexOf("UPDATE public.mail_working_draft_sends"));
    }
  });

  it("checkpoint finalizer acquires the advisory lock before row locks", () => {
    const src = migration();
    const start = src.indexOf("CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_checkpoint_if_active");
    const end = src.indexOf("CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_send", start);
    const fn = src.slice(start, end);
    expect(fn.indexOf("pg_advisory_xact_lock(")).toBeGreaterThan(-1);
    expect(fn.indexOf("pg_advisory_xact_lock(")).toBeLessThan(fn.indexOf("SELECT * INTO current_row"));
  });

  it("keeps preparing/failed non-fenced and sending/sent fenced", () => {
    expect(isDraftProviderCheckpointFenced("preparing")).toBe(false);
    expect(isDraftProviderCheckpointFenced("failed")).toBe(false);
    expect(isDraftProviderCheckpointFenced("sending")).toBe(true);
    expect(isDraftProviderCheckpointFenced("sent")).toBe(true);
  });

  it("save_mail_working_draft preserves an active running checkpoint", () => {
    const src = migration();
    expect(src).toContain("CREATE OR REPLACE FUNCTION public.save_mail_working_draft");
    expect(src).toContain("remote_checkpoint_state = CASE");
    expect(src).toContain("THEN 'running'");
    expect(src).toContain("ELSE 'pending'");
  });

  it("claim checkpoint still refuses an active running lease", () => {
    const src = claimMigration();
    expect(src).toContain("remote_checkpoint_state <> 'running'");
    expect(src).toContain("remote_checkpoint_lease_until IS NULL");
  });

  it("finalizer evaluates sending/sent before stale target revision", () => {
    const src = migration();
    const start = src.indexOf("CREATE OR REPLACE FUNCTION public.finish_mail_working_draft_checkpoint_if_active");
    const end = src.indexOf("CREATE OR REPLACE FUNCTION public.claim_mail_working_draft_send", start);
    const fn = src.slice(start, end);
    expect(fn.indexOf("SELECT * INTO send_row")).toBeLessThan(
      fn.indexOf("remote_checkpoint_target_revision IS DISTINCT"),
    );
  });

  it("stale newly-created APPEND UID is cleaned when finalizer does not commit", () => {
    const src = server();
    expect(src).toContain("if (!finalize.committed)");
    expect(src).toContain("deleteProviderDraftExplicit({");
  });
});
