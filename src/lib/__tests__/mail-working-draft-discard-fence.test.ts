import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = () =>
  readFileSync(
    new URL(
      "../../../supabase/migrations/20260818130000_mail_working_draft_discards.sql",
      import.meta.url,
    ),
    "utf8",
  );

const serverSource = () =>
  readFileSync(new URL("../mail-working-draft.server.ts", import.meta.url), "utf8");

function bodyOf(sql: string, functionName: string): string {
  const match = sql.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]*?\\$\\$;`,
      "i",
    ),
  );
  return match?.[0] ?? "";
}

function expectInOrder(body: string, labels: string[]) {
  let previous = -1;
  for (const label of labels) {
    const index = body.indexOf(label);
    expect(index, `expected ${label} to exist`).toBeGreaterThanOrEqual(0);
    expect(index, `expected ${label} after previous marker`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("atomic discard fence SQL contract", () => {
  const sql = migration();

  it("stores every known provider ref in a deduplicated jsonb collection", () => {
    expect(sql).toContain("provider_refs jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain("jsonb_agg(DISTINCT value)");
    expect(sql).toContain("mail_working_draft_discards.provider_refs || jsonb_build_array(p_ref)");
  });

  it("locks save, discard check, then mutates the working draft in that exact order", () => {
    const body = bodyOf(sql, "save_mail_working_draft");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "is_mail_working_draft_discarded",
      "INSERT INTO public.mail_working_drafts",
    ]);
  });

  it("fences checkpoint claim before a provider APPEND may start", () => {
    const body = bodyOf(sql, "claim_mail_working_draft_checkpoint");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "is_mail_working_draft_discarded",
      "UPDATE public.mail_working_drafts",
    ]);
    expect(body).toContain("RETURN QUERY SELECT false, NULL::uuid;");
  });

  it("fences the finalizer and merges a late provider ref into the tombstone", () => {
    const body = bodyOf(sql, "finish_mail_working_draft_checkpoint_if_active");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "is_mail_working_draft_discarded",
      "merge_mail_working_draft_provider_ref",
      "RETURN QUERY SELECT false, true, 'discarded'::text;",
    ]);
  });

  it("rejects send claim before inserting or preparing SMTP state", () => {
    const body = bodyOf(sql, "claim_mail_working_draft_send");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "is_mail_working_draft_discarded",
      "INSERT INTO public.mail_working_draft_sends",
    ]);
    expect(body).toContain("'discarded'::text");
  });

  it("rejects preparing->sending before SMTP can be invoked", () => {
    const body = bodyOf(sql, "mark_mail_working_draft_send_in_flight");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "is_mail_working_draft_discarded",
      "UPDATE public.mail_working_draft_sends",
    ]);
    expect(body).toContain("RETURN false;");
  });

  it("atomically authorizes attachment ownership instead of Node-only check-then-insert", () => {
    const body = bodyOf(sql, "create_mail_working_draft_attachment");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "is_mail_working_draft_discarded",
      "INSERT INTO public.mail_working_draft_attachments",
    ]);
    expect(body.indexOf("p_storage_path text,")).toBeGreaterThan(0);
    expect(body.indexOf("p_storage_path text,")).toBeLessThan(body.indexOf("p_disposition text DEFAULT NULL"));
    expect(body.indexOf("p_storage_path text,")).toBeLessThan(body.indexOf("p_cid text DEFAULT NULL"));
  });

  it("keeps the tombstone permanently after cleanup instead of deleting it", () => {
    const body = bodyOf(sql, "finish_mail_working_draft_discard_cleanup");
    expectInOrder(body, [
      "pg_advisory_xact_lock(",
      "DELETE FROM public.mail_working_drafts",
      "cleanup_state = 'cleaned'",
    ]);
    expect(body).not.toContain("DELETE FROM public.mail_working_draft_discards");
  });

  it("resets a cleaned tombstone back to pending when a late provider ref is merged", () => {
    const body = bodyOf(sql, "merge_mail_working_draft_provider_ref");
    expectInOrder(body, [
      "provider_refs = (",
      "cleanup_state = 'pending'",
      "cleanup_error = NULL",
      "updated_at = now()",
    ]);
  });

  it("fences stale save/send/upload even when the tombstone is in cleaned state", () => {
    for (const name of [
      "save_mail_working_draft",
      "claim_mail_working_draft_send",
      "create_mail_working_draft_attachment",
    ]) {
      const body = bodyOf(sql, name);
      expect(body).toContain("is_mail_working_draft_discarded");
      expect(body).not.toContain("cleanup_state");
    }
  });
});

describe("working draft server discard wiring", () => {
  const src = serverSource();

  it("exposes all tombstone provider refs for list suppression", () => {
    expect(src).toContain('.select("draft_id, provider_refs, cleanup_state")');
    expect(src).toContain("discardedProviderRefs: WorkingDraftSentRef[]");
    expect(src).toContain("Array.isArray(row.provider_refs)");
  });

  it("maps the discarded send claim to a deterministic DRAFT_DISCARDED error", () => {
    expect(src).toContain('state: "preparing" | "sending" | "sent" | "failed" | "discarded"');
    expect(src).toContain('if (claim.state === "discarded")');
    expect(src).toContain('throw new Error("DRAFT_DISCARDED");');
  });

  it("checks the discard tombstone again immediately before preparing->sending", () => {
    const markCall = src.indexOf("await markWorkingDraftSendInFlight(input.auth, input.draftId);");
    const ensureCall = src.indexOf("await ensureDraftNotDiscarded(input.auth, input.draftId);");
    expect(markCall).toBeGreaterThan(ensureCall);
  });

  it("uses the atomic attachment ownership RPC after upload", () => {
    expect(src).toContain('client.rpc(\n    "create_mail_working_draft_attachment"');
    expect(src).not.toContain('await ensureDraftShell(input.auth, input.draftId)');
  });

  it("discard returns after the tombstone RPC and does not await provider cleanup", () => {
    const start = src.indexOf("export async function discardWorkingDraft(");
    const end = src.indexOf("export async function deleteWorkingDraftExplicit(", start);
    const body = src.slice(start, end);
    expect(body).toContain("trackCloudflareWork(startDiscardedCleanup(input.auth, input.draftId));");
    expect(body).not.toContain("await startDiscardedCleanup");
  });

  it("deletes each provider ref through the existing provider delete helper", () => {
    const body = src.slice(
      src.indexOf("async function cleanupDiscardedWorkingDraft("),
      src.indexOf("function startDiscardedCleanup("),
    );
    expect(body).toContain("await deleteProviderDraftExplicit({");
    expect(body).toContain("previousRef: ref,");
  });

  it("advances the cleanup RPC after a successful provider delete", () => {
    const body = src.slice(
      src.indexOf("async function cleanupDiscardedWorkingDraft("),
      src.indexOf("function startDiscardedCleanup("),
    );
    expect(body).toContain("await advance(ref);");
  });

  it("leaves the tombstone and ref durable when provider deletion fails", () => {
    const body = src.slice(
      src.indexOf("async function cleanupDiscardedWorkingDraft("),
      src.indexOf("function startDiscardedCleanup("),
    );
    expect(body).toContain("allProviderDeletesSucceeded = false;");
    expect(body).toContain("if (!allProviderDeletesSucceeded) return;");
  });

  it("schedules Draft-list cleanup for pending/failed/non-empty tombstones without awaiting", () => {
    const body = src.slice(
      src.indexOf("for (const row of discardRows) {"),
      src.indexOf("for (const record of records) {"),
    );
    expect(body).toContain('if (row.cleanup_state !== "cleaned" || refs.length > 0)');
    expect(body).toContain("trackCloudflareWork(startDiscardedCleanup(auth, row.draft_id));");
    expect(body).not.toContain("await startDiscardedCleanup");
  });

  it("does not schedule repeated cleanup for a cleaned empty tombstone", () => {
    const body = src.slice(
      src.indexOf("for (const row of discardRows) {"),
      src.indexOf("for (const record of records) {"),
    );
    expect(body).toContain('if (row.cleanup_state !== "cleaned" || refs.length > 0)');
    expect(body).toContain("trackCloudflareWork(startDiscardedCleanup(auth, row.draft_id));");
  });

  it("performs safe draftId/provider cleanup with previousRef null when no refs exist", () => {
    const body = src.slice(
      src.indexOf("async function cleanupDiscardedWorkingDraft("),
      src.indexOf("function startDiscardedCleanup("),
    );
    expect(body).toContain("previousRef: null,");
  });

  it("removes owned storage only after the final cleanup RPC succeeds", () => {
    const body = src.slice(
      src.indexOf("async function cleanupDiscardedWorkingDraft("),
      src.indexOf("function startDiscardedCleanup("),
    );
    const purgeIndex = body.indexOf("const purged = await advance(null);");
    const storageIndex = body.indexOf(".remove(storagePaths)");
    expect(purgeIndex).toBeGreaterThanOrEqual(0);
    expect(storageIndex).toBeGreaterThan(purgeIndex);
    expect(body).toContain("if (purged && storagePaths.length > 0)");
  });

  it("uses a same-process single-flight map for concurrent cleanup calls", () => {
    expect(src).toContain("const discardedCleanupFlights = new Map<string, Promise<void>>();");
    expect(src).toContain("const existing = discardedCleanupFlights.get(key);");
    expect(src).toContain("if (existing) return existing;");
  });

  it("does not change send, checkpoint, inline, or non-Draft runtime wiring", () => {
    expect(src).toContain("export async function sendWorkingDraft(");
    expect(src).toContain("finish_mail_working_draft_checkpoint_if_active");
    expect(src).not.toContain("await ensureDraftShell(input.auth, input.draftId)");
  });
});
