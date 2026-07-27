// Phase-2 (R2) Worker runner — Server-only.
//
// Processes a single claimed mail_sync job:
//   1. resolve config       (mail-config.server)
//   2. decrypt credentials  (mail-credentials.server)
//   3. run runMailSyncCore  (mail-sync-runner.server)
//   4. classify result -> complete_mail_sync_job / fail_mail_sync_job
//
// Extracted from the tick route so it is unit-testable with fake
// bridgePost + fake admin client (no live IMAP / no Vault).
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAIL_QUEUE_CONFIG } from "./mail-queue-config";
import {
  classifyBridgeError,
  decideFailureAction,
  type MailQueueErrorCode,
} from "./mail-queue-backoff";

import { runMailSyncCore, type BridgePost } from "./mail-sync-runner.server";
import { resolveMailConfigForAccount, MailConfigIncompleteError } from "./mail-config.server";
import {
  loadDecryptedPasswordForAccount,
  MailCredentialsPendingError,
} from "./mail-credentials.server";

export interface WorkerJobMessage {
  company_id: string;
  account_id: string;
  folder_id: string;
  kind: "initial" | "incremental" | "reconcile";
  priority?: number;
  attempt?: number;
  folder_path?: string;
}

export interface WorkerClaimedJob {
  msg_id: number;
  read_ct: number;
  message: WorkerJobMessage;
}

export type WorkerJobOutcome =
  | { kind: "completed"; wroteMessages: number; total: number; unread: number }
  | { kind: "retried"; code: MailQueueErrorCode; delaySeconds: number }
  | { kind: "dead"; code: MailQueueErrorCode }
  | { kind: "skipped-idempotent" };



/** Look up a folder's `path` from mail_folders — only when the job payload
 *  omitted it (older messages / manual enqueues). */
async function resolveFolderPath(
  admin: SupabaseClient,
  folderId: string,
  accountId: string,
  companyId: string,
): Promise<{ path: string; canonical: string | null } | null> {
  const { data, error } = await admin
    .from("mail_folders")
    .select("path, canonical")
    .eq("id", folderId)
    .eq("account_id", accountId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  return { path: data.path as string, canonical: (data.canonical as string | null) ?? null };
}

export interface ProcessJobDeps {
  admin: SupabaseClient;
  workerId: string;
  bridgePost?: BridgePost;
}

/**
 * Execute a single claimed job end-to-end.
 * Pure function of (admin, deps, job): callers (route handler, tests)
 * invoke it directly; concurrency batching is handled by processClaimedBatch.
 */
export async function processClaimedJob(
  deps: ProcessJobDeps,
  job: WorkerClaimedJob,
): Promise<WorkerJobOutcome> {
  const { admin, workerId, bridgePost } = deps;
  const msg = job.message;

  let outcome: WorkerJobOutcome;

  try {
    const config = await resolveMailConfigForAccount(admin, msg.account_id, msg.company_id);

    let folderPath = msg.folder_path;
    let canonical: string | null = null;
    if (!folderPath) {
      const resolved = await resolveFolderPath(admin, msg.folder_id, msg.account_id, msg.company_id);
      if (!resolved) throw new MailConfigIncompleteError();
      folderPath = resolved.path;
      canonical = resolved.canonical;
    }

    const password = await loadDecryptedPasswordForAccount(
      admin,
      msg.account_id,
      msg.company_id,
    );

    const runResult = await runMailSyncCore(
      admin,
      {
        accountId: msg.account_id,
        companyId: msg.company_id,
        bridgeAccount: {
          email_address: config.emailAddress,
          display_name: config.displayName,
          imap_host: config.imapHost,
          imap_port: config.imapPort,
          imap_secure: config.imapSecure,
          smtp_host: config.smtpHost,
          smtp_port: config.smtpPort,
          smtp_secure: config.smtpSecure,
        },
        password,
        folderPath,
        canonical,
        mode: msg.kind,
      },
      bridgePost,
    );

    if (runResult.ok && !("busy" in runResult && runResult.busy)) {
      const r = runResult as Extract<typeof runResult, { busy: false }>;
      outcome = {
        kind: "completed",
        wroteMessages: r.wroteMessages,
        total: r.total,
        unread: r.unread,
      };
    } else if (runResult.ok && "busy" in runResult && runResult.busy) {
      // Another worker holds the folder lock — retry shortly.
      outcome = {
        kind: "retried",
        code: "MAIL_SYNC_BUSY",
        delaySeconds: 30,
      };
    } else {
      // ok:false path
      const errCode = (runResult as { code?: string }).code ?? "UNKNOWN";
      const classified = classifyBridgeError({ code: errCode });
      outcome = decideRetryOrDead(classified, job.read_ct);
    }
  } catch (err) {
    if (err instanceof MailCredentialsPendingError) {
      outcome = { kind: "dead", code: "AUTH" };
    } else if (err instanceof MailConfigIncompleteError) {
      outcome = { kind: "dead", code: "INVALID_CONFIG" };
    } else {
      const classified = classifyBridgeError({ message: (err as Error)?.message ?? "" });
      outcome = decideRetryOrDead(classified, job.read_ct);
    }
  }

  await commitOutcome(admin, workerId, job.msg_id, outcome);
  return outcome;
}

function decideRetryOrDead(code: MailQueueErrorCode, readCt: number): WorkerJobOutcome {
  // read_ct is 1 after the first claim, so treat it as the attempt count.
  const decision = decideFailureAction({ code, attempt: Math.max(1, readCt) });
  if (decision.action === "retry") {
    return { kind: "retried", code, delaySeconds: decision.delaySeconds };
  }
  return { kind: "dead", code };
}


async function commitOutcome(
  admin: SupabaseClient,
  workerId: string,
  msgId: number,
  outcome: WorkerJobOutcome,
): Promise<void> {
  if (outcome.kind === "completed") {
    await admin.rpc("complete_mail_sync_job", {
      p_worker_id: workerId,
      p_msg_id: msgId,
    });
    return;
  }
  if (outcome.kind === "retried") {
    await admin.rpc("fail_mail_sync_job", {
      p_worker_id: workerId,
      p_msg_id: msgId,
      p_action: "retry",
      p_delay_seconds: outcome.delaySeconds,
      p_error_code: outcome.code,
      p_error_message: null,
    });
    return;
  }
  if (outcome.kind === "dead") {
    await admin.rpc("fail_mail_sync_job", {
      p_worker_id: workerId,
      p_msg_id: msgId,
      p_action: "dead",
      p_delay_seconds: null,
      p_error_code: outcome.code,
      p_error_message: null,
    });
    return;
  }
  // skipped-idempotent — nothing to write
}

/**
 * Concurrency-limited batch processor.
 * Pool size is capped by MAIL_QUEUE_CONFIG.globalConcurrency but the caller
 * should also respect per-tick claim size (claimBatchSize).
 */
export async function processClaimedBatch(
  deps: ProcessJobDeps,
  jobs: WorkerClaimedJob[],
  poolSize: number = MAIL_QUEUE_CONFIG.claimBatchSize,
): Promise<WorkerJobOutcome[]> {
  const results: WorkerJobOutcome[] = new Array(jobs.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= jobs.length) return;
      try {
        results[idx] = await processClaimedJob(deps, jobs[idx]);
      } catch (err) {
        // processClaimedJob already commits — this is a defensive guard for
        // truly unexpected errors (e.g. commitOutcome itself throwing).
        console.error("[mail-worker] processClaimedJob threw unexpectedly", {
          msg_id: jobs[idx]?.msg_id,
          error: (err as Error)?.message?.slice(0, 200),
        });
        results[idx] = { kind: "dead", code: "UNKNOWN" };
      }
    }
  };
  const n = Math.max(1, Math.min(poolSize, jobs.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
