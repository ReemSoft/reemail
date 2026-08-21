import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { BridgeAuthOk } from "@/lib/mail-bridge-auth.server";
import { trackCloudflareWork } from "@/lib/cloudflare-wait-until.server";
import {
  createNormalComposeMessageId,
  isNormalSendId,
} from "@/lib/mail-normal-send-idempotency";
import { isDefinitePreSmtpSendError } from "@/lib/mail-working-draft-send-idempotency";

type UntypedDb = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: unknown;
  }>;
};

type NormalSendState = "preparing" | "sending" | "sent" | "failed";

type NormalSendClaim = {
  claimed: boolean;
  state: NormalSendState;
  messageId: string;
  smtpResult: Record<string, unknown> | null;
  error: string | null;
};

export type NormalSendHttpResult = {
  status: number;
  body: Record<string, unknown>;
  serverTiming?: string | null;
};

type NormalSendPayload = Record<string, unknown>;

function db(): UntypedDb {
  return supabaseAdmin as unknown as UntypedDb;
}

function claimFromRpc(data: unknown): NormalSendClaim | null {
  if (!Array.isArray(data)) return null;
  const row = data[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.state !== "string" || typeof row.message_id !== "string") return null;
  if (!["preparing", "sending", "sent", "failed"].includes(row.state)) return null;
  return {
    claimed: row.claimed === true,
    state: row.state as NormalSendState,
    messageId: row.message_id,
    smtpResult:
      row.smtp_result && typeof row.smtp_result === "object"
        ? (row.smtp_result as Record<string, unknown>)
        : null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

async function claimNormalSend(
  auth: BridgeAuthOk,
  sendId: string,
  proposedMessageId: string,
): Promise<NormalSendClaim> {
  const { data, error } = await db().rpc("claim_mail_normal_send", {
    p_send_id: sendId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_message_id: proposedMessageId,
  });
  if (error) throw new Error("NORMAL_SEND_CLAIM_FAILED");
  const claim = claimFromRpc(data);
  if (!claim) throw new Error("NORMAL_SEND_CLAIM_INVALID_REPLY");
  return claim;
}

async function markNormalSendInFlight(
  auth: BridgeAuthOk,
  sendId: string,
  messageId: string,
): Promise<boolean> {
  const { data, error } = await db().rpc("mark_mail_normal_send_in_flight", {
    p_send_id: sendId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_message_id: messageId,
  });
  if (error) throw new Error("NORMAL_SEND_IN_FLIGHT_FAILED");
  return data === true;
}

async function markNormalSendSent(
  auth: BridgeAuthOk,
  sendId: string,
  messageId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await db().rpc("mark_mail_normal_send_sent", {
    p_send_id: sendId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_message_id: messageId,
    p_result: result,
  });
  if (error || data !== true) throw new Error("NORMAL_SEND_COMMIT_FAILED");
}

async function markNormalSendFailed(
  auth: BridgeAuthOk,
  sendId: string,
  messageId: string,
  reason: string,
): Promise<void> {
  const { error } = await db().rpc("mark_mail_normal_send_failed", {
    p_send_id: sendId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_message_id: messageId,
    p_error: reason.slice(0, 120),
  });
  if (error) throw new Error("NORMAL_SEND_FAILURE_COMMIT_FAILED");
}

async function reclaimNormalSendAfterUnknown(
  auth: BridgeAuthOk,
  sendId: string,
  messageId: string,
): Promise<boolean> {
  const { data, error } = await db().rpc("reclaim_mail_normal_send_after_unknown", {
    p_send_id: sendId,
    p_company_id: auth.companyId,
    p_account_id: auth.accountId,
    p_message_id: messageId,
  });
  if (error) throw new Error("NORMAL_SEND_RECLAIM_FAILED");
  return data === true;
}

type Reconciliation = "found" | "not-found" | "unavailable";

async function reconcileNormalSend(
  auth: BridgeAuthOk,
  password: string,
  messageId: string,
): Promise<Reconciliation> {
  try {
    const response = await fetch(`${auth.bridgeUrl}/api/send-reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Key": auth.bridgeKey },
      body: JSON.stringify({
        account: auth.bridgeAccount,
        password,
        messageId,
      }),
    });
    const result = (await response.json().catch(() => null)) as
      | { ok?: boolean; found?: boolean }
      | null;
    if (!response.ok || !result?.ok || typeof result.found !== "boolean") {
      return "unavailable";
    }
    return result.found ? "found" : "not-found";
  } catch {
    return "unavailable";
  }
}

function clientHandles(payload: NormalSendPayload): string[] {
  const handles = new Set<string>();
  if (Array.isArray(payload.attachmentHandles)) {
    for (const handle of payload.attachmentHandles) {
      if (typeof handle === "string") handles.add(handle);
    }
  }
  if (Array.isArray(payload.stagedInlineImages)) {
    for (const item of payload.stagedInlineImages) {
      if (!item || typeof item !== "object") continue;
      const handle = (item as Record<string, unknown>).handle;
      if (typeof handle === "string") handles.add(handle);
    }
  }
  return [...handles];
}

function scheduleClientHandleRelease(auth: BridgeAuthOk, payload: NormalSendPayload): void {
  const handles = clientHandles(payload);
  if (handles.length === 0) return;
  const release = fetch(`${auth.bridgeUrl}/api/staged-release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Key": auth.bridgeKey },
    body: JSON.stringify({ account: auth.bridgeAccount, handles }),
  }).then(() => undefined);
  trackCloudflareWork(release);
}

function unknownOutcome(messageId: string): NormalSendHttpResult {
  return {
    status: 409,
    body: {
      ok: false,
      code: "SEND_OUTCOME_UNKNOWN",
      error: "SEND_OUTCOME_UNKNOWN",
      messageId,
    },
  };
}

function inProgress(): NormalSendHttpResult {
  return {
    status: 409,
    body: { ok: false, code: "SEND_IN_PROGRESS", error: "SEND_IN_PROGRESS" },
  };
}

/**
 * Durable normal-Compose SMTP single-flight.
 *
 * DB state is authoritative across app instances. Once state reaches
 * "sending", it is never reclaimed automatically: retries first reconcile
 * Sent by the stable Message-ID, and only explicit user confirmation may
 * reclaim an unresolved outcome for another SMTP attempt.
 */
export async function sendNormalCompose(input: {
  auth: BridgeAuthOk;
  password: string;
  sendId: string;
  confirmResendUnknown?: boolean;
  payload: NormalSendPayload;
}): Promise<NormalSendHttpResult> {
  if (!isNormalSendId(input.sendId)) throw new Error("INVALID_SEND_ID");

  const proposedMessageId = createNormalComposeMessageId(
    input.sendId,
    input.auth.bridgeAccount.email_address,
  );
  let claim = await claimNormalSend(input.auth, input.sendId, proposedMessageId);

  if (claim.state === "sent") {
    scheduleClientHandleRelease(input.auth, input.payload);
    return {
      status: 200,
      body:
        claim.smtpResult ?? {
          ok: true,
          messageId: claim.messageId,
          recoveredFromIdempotency: true,
        },
    };
  }

  if (claim.state === "sending") {
    const reconciliation = await reconcileNormalSend(
      input.auth,
      input.password,
      claim.messageId,
    );
    if (reconciliation === "found") {
      const recovered = {
        ok: true,
        messageId: claim.messageId,
        sentCopySaved: true,
        sentCopyPending: false,
        recoveredFromSent: true,
      };
      try {
        await markNormalSendSent(input.auth, input.sendId, claim.messageId, recovered);
      } catch {
        return unknownOutcome(claim.messageId);
      }
      scheduleClientHandleRelease(input.auth, input.payload);
      return { status: 200, body: recovered };
    }

    // "not-found" is not proof SMTP failed (provider lag/no Sent auto-copy).
    // Re-send remains explicit-only, matching the Working Draft contract.
    if (!input.confirmResendUnknown) return unknownOutcome(claim.messageId);

    const reclaimed = await reclaimNormalSendAfterUnknown(
      input.auth,
      input.sendId,
      claim.messageId,
    );
    if (!reclaimed) {
      const refreshed = await claimNormalSend(input.auth, input.sendId, proposedMessageId);
      if (refreshed.state === "sent") {
        scheduleClientHandleRelease(input.auth, input.payload);
        return {
          status: 200,
          body:
            refreshed.smtpResult ?? {
              ok: true,
              messageId: refreshed.messageId,
              recoveredFromIdempotency: true,
            },
        };
      }
      if (refreshed.state === "sending") return unknownOutcome(refreshed.messageId);
      if (!refreshed.claimed) return inProgress();
      claim = refreshed;
    } else {
      claim = {
        claimed: true,
        state: "preparing",
        messageId: claim.messageId,
        smtpResult: null,
        error: null,
      };
    }
  }

  if (!claim.claimed) return inProgress();

  const inFlight = await markNormalSendInFlight(input.auth, input.sendId, claim.messageId);
  if (!inFlight) return inProgress();

  let upstream: Response;
  try {
    upstream = await fetch(`${input.auth.bridgeUrl}/api/send-v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Key": input.auth.bridgeKey },
      body: JSON.stringify({
        account: input.auth.bridgeAccount,
        password: input.password,
        ...input.payload,
        messageId: claim.messageId,
        // Do not delete browser-staged handles until DB state is durably "sent".
        // If the app response/commit is lost after SMTP acceptance, the same
        // handles remain available for the explicit-retry path.
        retainClientHandlesOnSuccess: true,
      }),
    });
  } catch {
    return unknownOutcome(claim.messageId);
  }

  const serverTiming = upstream.headers.get("Server-Timing");
  const result = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;

  if (!result) return unknownOutcome(claim.messageId);

  if (!upstream.ok || result.ok !== true) {
    if (isDefinitePreSmtpSendError(result.error)) {
      await markNormalSendFailed(
        input.auth,
        input.sendId,
        claim.messageId,
        typeof result.error === "string" ? result.error : "SEND_REJECTED",
      ).catch(() => undefined);
      return { status: upstream.status, body: result, serverTiming };
    }
    return unknownOutcome(claim.messageId);
  }

  try {
    await markNormalSendSent(input.auth, input.sendId, claim.messageId, result);
  } catch {
    return unknownOutcome(claim.messageId);
  }

  scheduleClientHandleRelease(input.auth, input.payload);
  return { status: upstream.status, body: result, serverTiming };
}
