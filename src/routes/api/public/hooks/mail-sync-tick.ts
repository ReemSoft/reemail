// Phase-2 (R2) Worker HTTP route — /api/public/hooks/mail-sync-tick
//
// Bypass-auth prefix (/api/public/*) is safe here because access is gated
// by the mail_sync tick token (verify_mail_sync_tick_token RPC). The token
// is stored in the `mail_sync_private.tick_token` table (schema created in
// R1, service_role only) and injected by pg_cron via pg_net headers.
//
// Contract:
//   POST /api/public/hooks/mail-sync-tick
//   header: x-mail-sync-tick-token: <shared secret>
//   body (optional): { batchSize?: number }
//
// Returns: { ok: true, claimed, completed, retried, dead, elapsedMs }
// Never leaks: config, credentials, tokens, secrets.
import { createFileRoute } from "@tanstack/react-router";
import { MAIL_QUEUE_CONFIG } from "@/lib/mail-queue-config";

export const Route = createFileRoute("/api/public/hooks/mail-sync-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const started = Date.now();
        const token = request.headers.get("x-mail-sync-tick-token") ?? "";
        if (!token) {
          return new Response(JSON.stringify({ error: "MISSING_TOKEN" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // Verify shared-secret token via SECURITY DEFINER RPC (constant-time compare).
        const tokenCheck = await supabaseAdmin.rpc("verify_mail_sync_tick_token", {
          p_token: token,
        });
        if (tokenCheck.error || tokenCheck.data !== true) {
          return new Response(JSON.stringify({ error: "INVALID_TOKEN" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        let bodyBatch: number | undefined;
        try {
          const b = (await request.json().catch(() => null)) as { batchSize?: number } | null;
          if (b && typeof b.batchSize === "number") bodyBatch = b.batchSize;
        } catch {
          /* body optional */
        }

        const batchSize = Math.max(
          1,
          Math.min(bodyBatch ?? MAIL_QUEUE_CONFIG.claimBatchSize, MAIL_QUEUE_CONFIG.claimBatchSize),
        );

        // Step 1: enqueue any due scheduled jobs. Runs before claim so this
        // tick can immediately pick them up.
        try {
          await (supabaseAdmin.rpc as (fn: string) => Promise<unknown>)("enqueue_due_mail_sync_jobs");
        } catch (err) {
          console.error("[mail-sync-tick] enqueue_due failed", {
            msg: (err as Error)?.message?.slice(0, 120),
          });
          // Non-fatal: continue to claim already-enqueued jobs.
        }

        // Step 2: claim a batch of jobs.
        const workerId = `worker:${crypto.randomUUID()}`;
        const claim = await supabaseAdmin.rpc("claim_mail_sync_jobs", {
          p_worker_id: workerId,
          p_batch_size: batchSize,
          p_lease_seconds: MAIL_QUEUE_CONFIG.leaseSeconds,
          p_global_concurrency: MAIL_QUEUE_CONFIG.globalConcurrency,
          p_per_company_concurrency: MAIL_QUEUE_CONFIG.perCompanyConcurrency,
          p_per_account_concurrency: MAIL_QUEUE_CONFIG.perAccountConcurrency,
        });
        if (claim.error) {
          console.error("[mail-sync-tick] claim failed", {
            code: claim.error.code,
            msg: claim.error.message?.slice(0, 120),
          });
          return new Response(
            JSON.stringify({ error: "CLAIM_FAILED", code: claim.error.code ?? "UNKNOWN" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const rows = (claim.data ?? []) as Array<{
          msg_id: number;
          read_ct: number;
          message: {
            company_id: string;
            account_id: string;
            folder_id: string;
            kind: "initial" | "incremental" | "reconcile";
            folder_path?: string;
          };
        }>;

        if (rows.length === 0) {
          return new Response(
            JSON.stringify({
              ok: true,
              claimed: 0,
              completed: 0,
              retried: 0,
              dead: 0,
              elapsedMs: Date.now() - started,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const { processClaimedBatch } = await import("@/lib/mail-worker-runner.server");
        const outcomes = await processClaimedBatch(
          { admin: supabaseAdmin, workerId },
          rows.map((r) => ({ msg_id: r.msg_id, read_ct: r.read_ct, message: r.message })),
        );

        const stats = { completed: 0, retried: 0, dead: 0 };
        for (const o of outcomes) {
          if (o.kind === "completed") stats.completed++;
          else if (o.kind === "retried") stats.retried++;
          else if (o.kind === "dead") stats.dead++;
        }

        return new Response(
          JSON.stringify({
            ok: true,
            claimed: rows.length,
            ...stats,
            elapsedMs: Date.now() - started,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
