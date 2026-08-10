import { createTransport } from "nodemailer";
import type { ImapFlow, ListResponse } from "imapflow";
import type { Readable } from "node:stream";
import { makeImapClient, listMailboxes } from "./imap.js";
import {
  createMimeSpool,
  readMimeSpoolBuffer,
  withMimeSpoolReadStream,
  type MimeSpool,
} from "./mime-spool.js";
import {
  postSendFinalizers,
  type PostSendFinalizerQueue,
  type SentCopyEnqueueResult,
  type SentCopyOutcome,
  type SentCopyState,
} from "./post-send-finalizer.js";
import type { MailAccount } from "./types.js";
import { accountBinding } from "./transfer-tickets.js";
import {
  classifyImapFailure,
  type ClassifiedImapFailure,
  type SafeImapFailureCode,
} from "./imap-failure.js";

export interface SendAttachment {
  filename: string;
  /** In-memory bytes. Prefer `path` for anything > a few KB. */
  content?: Buffer;
  /** On-disk path — nodemailer streams it, keeping RSS flat. */
  path?: string;
  contentType?: string;
  cid?: string;
  contentDisposition?: "inline" | "attachment";
}

export interface SendMessagePayload {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  bcc?: { name: string; email: string }[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
  bodyHtml?: string;
  bodyText?: string;
  attachments?: SendAttachment[];
}

export interface SendMessageOk {
  ok: true;
  messageId: string;
  /** Whether the message is present in the Sent folder (either the provider
   *  auto-saved it or we appended a copy). false ⇒ delivered but no Sent copy. */
  sentCopySaved: boolean;
}
export interface SendMessageErr {
  ok: false;
  error: string;
}

export interface FastSendMessageOk extends SendMessageOk {
  sentCopyPending: boolean;
  sentCopyJobId?: string;
  sentCopyState: SentCopyState;
  timings: { mimeSpoolMs: number; smtpMs: number };
}

const SENT_SEARCH_RETRIES = 3;
const SENT_SEARCH_INTERVAL_MS = 500;

/**
 * Resolve the true Sent folder path using IMAP SPECIAL-USE first, then well-
 * known names that actually exist in the LIST response. Returns undefined if
 * no suitable Sent mailbox is present — never creates one.
 */
export function resolveSentPath(mailboxes: ListResponse[]): string | undefined {
  const selectable = (mailbox: ListResponse) => {
    const flags = (mailbox as unknown as { flags?: Set<string> | string[] }).flags;
    if (!flags) return true;
    const normalized = Array.from(flags, (flag) => flag.toLowerCase());
    return !normalized.includes("\\noselect") && !normalized.includes("\\nonexistent");
  };
  // 1) SPECIAL-USE \Sent (RFC 6154)
  for (const mb of mailboxes) {
    if (!selectable(mb)) continue;
    const su = (mb as unknown as { specialUse?: string | string[] }).specialUse;
    if (!su) continue;
    if (Array.isArray(su) ? su.includes("\\Sent") : su === "\\Sent") return mb.path;
  }
  // 2) Well-known Sent names that actually exist on the server.
  const known = [
    "Sent",
    "Sent Items",
    "Sent Mail",
    "[Gmail]/Sent Mail",
    "[Gmail]/Sent",
    "INBOX.Sent",
    "المرسلة",
  ];
  for (const name of known) {
    const found = mailboxes.find(
      (m) => selectable(m) && m.path.toLowerCase() === name.toLowerCase(),
    );
    if (found) return found.path;
  }
  return undefined;
}

/**
 * Resolve the true Drafts folder path using IMAP SPECIAL-USE \Drafts first,
 * then well-known names that actually exist in the LIST response. Never
 * assumes "Drafts" is present and never creates it.
 */
export function resolveDraftsPath(mailboxes: ListResponse[]): string | undefined {
  // 1) SPECIAL-USE \Drafts (RFC 6154) — authoritative per server.
  for (const mb of mailboxes) {
    const su = (mb as unknown as { specialUse?: string | string[] }).specialUse;
    if (!su) continue;
    if (Array.isArray(su) ? su.includes("\\Drafts") : su === "\\Drafts") return mb.path;
  }
  // 2) Well-known Drafts names, matched case-insensitively.
  const known = [
    "Drafts",
    "Draft",
    "[Gmail]/Drafts",
    "INBOX.Drafts",
    "المسودات",
    "المسوّدات",
    "مسودات",
  ];
  for (const name of known) {
    const found = mailboxes.find((m) => m.path.toLowerCase() === name.toLowerCase());
    if (found) return found.path;
  }
  return undefined;
}

/**
 * Resolve the true Trash folder path. Conservative: SPECIAL-USE \Trash first,
 * then a small allowlist of well-known Trash names that ACTUALLY exist on the
 * server. Never trusts caller-supplied paths, never creates a folder. Returns
 * undefined when no safe Trash target exists.
 *
 * Used by the drafts MOVE fallback (bridge/src/drafts.ts) on servers that
 * advertise MOVE but not UIDPLUS: stale draft copies are moved to Trash
 * instead of being selectively expunged.
 */
export function resolveTrashPath(mailboxes: ListResponse[]): string | undefined {
  for (const mb of mailboxes) {
    const su = (mb as unknown as { specialUse?: string | string[] }).specialUse;
    if (!su) continue;
    if (Array.isArray(su) ? su.includes("\\Trash") : su === "\\Trash") return mb.path;
  }
  const known = ["Trash", "Deleted Items", "Deleted", "[Gmail]/Trash", "[Gmail]/Bin"];
  for (const name of known) {
    const found = mailboxes.find((m) => m.path.toLowerCase() === name.toLowerCase());
    if (found) return found.path;
  }
  return undefined;
}

/** Case-insensitive Message-ID search in the given mailbox. */
async function messageExistsInFolder(
  client: ImapFlow,
  folderPath: string,
  messageId: string,
): Promise<boolean> {
  const lock = await client.getMailboxLock(folderPath);
  try {
    // Some IMAP servers include the surrounding <> in header searches, some
    // don't. Try the raw ID first; imapflow will quote appropriately.
    const uids = (await client.search({ header: { "message-id": messageId } } as never, {
      uid: true,
    })) as number[] | false;
    return Array.isArray(uids) && uids.length > 0;
  } finally {
    lock.release();
  }
}

/**
 * Send the message via SMTP, then best-effort save a copy in Sent:
 *   1) resolve Sent path via SPECIAL-USE / existing well-known names
 *   2) search Sent for our Message-ID (up to 3 × 500ms) — the provider may
 *      auto-save (Gmail, most managed hosts do)
 *   3) if still not found, APPEND the exact same MIME with \Seen
 *
 * SMTP success + sent-copy failure is still a successful send:
 *   returns { ok: true, sentCopySaved: false }. Never asks the user to resend.
 */
/**
 * Injectable IO surface for `sendMessage`. Production wires these to the real
 * nodemailer transport and imapflow client; tests inject fakes to drive
 * every branch of the Sent-copy state machine without touching the network.
 *
 * Do NOT export "convenience" wrappers over these — keeping the surface
 * minimal is the whole point: the regression tests must fail if a real code
 * path stops calling Search or APPEND.
 */
export interface SmtpTransport {
  sendMail(opts: { raw: Readable; envelope: { from: string; to: string[] } }): Promise<unknown>;
  close(): void;
}
export interface ImapSentClient {
  connect(): Promise<void>;
  list(): Promise<ListResponse[]>;
  searchMessageId(folderPath: string, messageId: string): Promise<boolean>;
  /** ImapFlow 1.5 accepts `string | Buffer` only — never a Readable. */
  append(folderPath: string, raw: Buffer, flags: string[]): Promise<unknown | false>;
  logout(): Promise<void>;
}
export interface SendMessageDeps {
  createTransport: (account: MailAccount, password: string) => SmtpTransport;
  createImapSentClient: (account: MailAccount, password: string) => ImapSentClient;
  createMimeSpool?: (payload: SendMessagePayload) => Promise<MimeSpool>;
  sleep?: (ms: number) => Promise<void>;
  postSendQueue?: Partial<Pick<PostSendFinalizerQueue, "enqueue" | "enqueueTracked">>;
}

export function sentCopyAccountKey(account: MailAccount): string {
  return accountBinding(account);
}

export function smtpRejectUnauthorized(env = process.env): boolean {
  return !/^(1|true|yes|on)$/i.test(env.MAIL_ALLOW_INSECURE_TLS || "");
}

/** Production deps — real nodemailer + imapflow. Kept out of module scope so
 *  test builds don't pay for it and so mis-wired tests can't accidentally
 *  reach the network. */
function defaultDeps(): SendMessageDeps {
  return {
    createTransport(account, password) {
      const t = createTransport({
        host: account.smtp_host,
        port: account.smtp_port,
        secure: account.smtp_secure,
        auth: { user: account.email_address, pass: password },
        tls: {
          rejectUnauthorized: smtpRejectUnauthorized(),
        },
      });
      return {
        sendMail: (opts) => t.sendMail(opts),
        close: () => t.close(),
      };
    },
    createImapSentClient(account, password) {
      const client = makeImapClient(account, password);
      return {
        connect: () => client.connect(),
        list: () => listMailboxes(client),
        searchMessageId: (folderPath, messageId) =>
          messageExistsInFolder(client, folderPath, messageId),
        append: async (folderPath, raw, flags) => {
          const result = await client.append(folderPath, raw, flags);
          if (result === false) {
            const error = new Error("IMAP append client is not usable") as Error & { code: string };
            error.code = "ECONNECTIONCLOSED";
            throw error;
          }
          return result;
        },
        logout: () => client.logout().catch(() => {}) as unknown as Promise<void>,
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

type SentSearchResult =
  | { state: "found" }
  | { state: "not-found" }
  | { state: "failed"; failure: ClassifiedImapFailure };

function sentCopyLog(
  stage:
    | "SEARCH_FAILED"
    | "APPEND_RETRYABLE_FAILURE"
    | "APPEND_PERMANENT_FAILURE"
    | "RECOVERY_SEARCH_FOUND"
    | "APPEND_RETRY_SUCCESS"
    | "FINAL_SENT_COPY_FAILURE",
  failure: ClassifiedImapFailure,
  attempt: number,
  startedAt: number,
): void {
  console.warn("[bridge] sent-copy recovery", {
    stage,
    code: failure.code,
    attempt,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    retryable: failure.retryable,
  });
}

async function searchSentBounded(
  client: ImapSentClient,
  folderPath: string,
  messageId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<SentSearchResult> {
  for (let attempt = 0; attempt < SENT_SEARCH_RETRIES; attempt++) {
    try {
      if (await client.searchMessageId(folderPath, messageId)) return { state: "found" };
    } catch (error) {
      return { state: "failed", failure: classifyImapFailure(error) };
    }
    if (attempt < SENT_SEARCH_RETRIES - 1) await sleep(SENT_SEARCH_INTERVAL_MS);
  }
  return { state: "not-found" };
}

async function appendSentCopy(
  client: ImapSentClient,
  folderPath: string,
  spool: MimeSpool,
): Promise<{ ok: true } | { ok: false; failure: ClassifiedImapFailure }> {
  try {
    // Re-read the same spool bytes for every attempt: byte-identical MIME,
    // no global buffer, no cache. Buffer is required by ImapFlow's contract.
    const raw = await readMimeSpoolBuffer(spool);
    const result = await client.append(folderPath, raw, ["\\Seen"]);
    if (result === false) {
      return {
        ok: false,
        failure: { code: "IMAP_CONNECTION_CLOSED", retryable: true },
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: classifyImapFailure(error) };
  }
}

async function closeSentClient(client: ImapSentClient | null): Promise<void> {
  await client?.logout().catch(() => undefined);
}

async function openSentClient(
  account: MailAccount,
  password: string,
  deps: SendMessageDeps,
): Promise<
  | { ok: true; client: ImapSentClient; sentPath: string }
  | {
      ok: false;
      client: ImapSentClient | null;
      code: SafeImapFailureCode | "SENT_FOLDER_NOT_FOUND";
    }
> {
  let client: ImapSentClient | null = null;
  try {
    client = deps.createImapSentClient(account, password);
    await client.connect();
    const sentPath = resolveSentPath(await client.list());
    if (!sentPath) return { ok: false, client, code: "SENT_FOLDER_NOT_FOUND" };
    return { ok: true, client, sentPath };
  } catch (error) {
    return { ok: false, client, code: classifyImapFailure(error).code };
  }
}

async function finalizeSentCopySafely(
  account: MailAccount,
  password: string,
  spool: MimeSpool,
  deps: SendMessageDeps,
): Promise<SentCopyOutcome> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = performance.now();
  let opened = await openSentClient(account, password, deps);
  if (opened.ok === false) {
    await closeSentClient(opened.client);
    return { state: "failed", code: opened.code };
  }
  let { client, sentPath } = opened;
  let search = await searchSentBounded(client, sentPath, spool.messageId, sleep);
  if (search.state === "found") {
    await closeSentClient(client);
    return { state: "saved", source: "provider" };
  }
  if (search.state === "failed") {
    const initialSearchFailure = search.failure;
    sentCopyLog("SEARCH_FAILED", initialSearchFailure, 1, startedAt);
    await closeSentClient(client);
    opened = await openSentClient(account, password, deps);
    if (opened.ok === false) {
      await closeSentClient(opened.client);
      return { state: "failed", code: opened.code };
    }
    ({ client, sentPath } = opened);
    search = await searchSentBounded(client, sentPath, spool.messageId, sleep);
    if (search.state === "found") {
      sentCopyLog("RECOVERY_SEARCH_FOUND", initialSearchFailure, 0, startedAt);
      await closeSentClient(client);
      return { state: "saved", source: "provider" };
    }
    if (search.state === "failed") {
      sentCopyLog("FINAL_SENT_COPY_FAILURE", search.failure, 0, startedAt);
      await closeSentClient(client);
      return { state: "failed", code: search.failure.code };
    }
  }

  const firstAppend = await appendSentCopy(client, sentPath, spool);
  if (firstAppend.ok === true) {
    await closeSentClient(client);
    return { state: "saved", source: "append" };
  }
  sentCopyLog(
    firstAppend.failure.retryable ? "APPEND_RETRYABLE_FAILURE" : "APPEND_PERMANENT_FAILURE",
    firstAppend.failure,
    1,
    startedAt,
  );
  await closeSentClient(client);

  opened = await openSentClient(account, password, deps);
  if (opened.ok === false) {
    await closeSentClient(opened.client);
    return { state: "failed", code: opened.code };
  }
  ({ client, sentPath } = opened);
  search = await searchSentBounded(client, sentPath, spool.messageId, sleep);
  if (search.state === "found") {
    sentCopyLog("RECOVERY_SEARCH_FOUND", firstAppend.failure, 1, startedAt);
    await closeSentClient(client);
    return { state: "saved", source: "append" };
  }
  if (search.state === "failed") {
    sentCopyLog("FINAL_SENT_COPY_FAILURE", search.failure, 1, startedAt);
    await closeSentClient(client);
    return { state: "failed", code: search.failure.code };
  }
  if (!firstAppend.failure.retryable) {
    sentCopyLog("FINAL_SENT_COPY_FAILURE", firstAppend.failure, 1, startedAt);
    await closeSentClient(client);
    return { state: "failed", code: firstAppend.failure.code };
  }

  const secondAppend = await appendSentCopy(client, sentPath, spool);
  if (secondAppend.ok === true) {
    sentCopyLog("APPEND_RETRY_SUCCESS", firstAppend.failure, 2, startedAt);
    await closeSentClient(client);
    return { state: "saved", source: "append" };
  }
  await closeSentClient(client);

  opened = await openSentClient(account, password, deps);
  if (opened.ok === false) {
    await closeSentClient(opened.client);
    return { state: "failed", code: opened.code };
  }
  ({ client, sentPath } = opened);
  search = await searchSentBounded(client, sentPath, spool.messageId, sleep);
  await closeSentClient(client);
  if (search.state === "found") {
    sentCopyLog("RECOVERY_SEARCH_FOUND", secondAppend.failure, 2, startedAt);
    return { state: "saved", source: "append" };
  }
  const finalFailure = search.state === "failed" ? search.failure : secondAppend.failure;
  sentCopyLog("FINAL_SENT_COPY_FAILURE", finalFailure, 2, startedAt);
  return { state: "failed", code: finalFailure.code };
}

export async function sendMessageFast(
  account: MailAccount,
  password: string,
  payload: SendMessagePayload,
  deps: SendMessageDeps = defaultDeps(),
): Promise<FastSendMessageOk | SendMessageErr> {
  const spoolStartedAt = performance.now();
  let spool: MimeSpool;
  try {
    spool = await (deps.createMimeSpool ?? createMimeSpool)(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to build MIME";
    return { ok: false, error: message };
  }
  const mimeSpoolMs = performance.now() - spoolStartedAt;

  const smtpStartedAt = performance.now();
  let transporter: SmtpTransport | null = null;
  try {
    transporter = deps.createTransport(account, password);
    const envelopeRecipients = [...payload.to, ...(payload.cc || []), ...(payload.bcc || [])].map(
      (recipient) => recipient.email,
    );
    await withMimeSpoolReadStream(spool, (raw) =>
      transporter.sendMail({
        raw,
        envelope: { from: payload.from.email, to: envelopeRecipients },
      }),
    );
  } catch (error) {
    await spool.cleanup().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Failed to send message";
    return { ok: false, error: message };
  } finally {
    try {
      transporter?.close();
    } catch {
      /* SMTP acceptance remains authoritative even if local close throws. */
    }
  }
  const smtpMs = performance.now() - smtpStartedAt;

  const queue = deps.postSendQueue ?? postSendFinalizers;
  const accountKey = sentCopyAccountKey(account);
  const finalizeSentCopy = async (): Promise<SentCopyOutcome> => {
    try {
      return await finalizeSentCopySafely(account, password, spool, deps);
    } catch (error) {
      return { state: "failed", code: classifyImapFailure(error).code };
    } finally {
      await spool.cleanup().catch(() => undefined);
    }
  };
  let queued: SentCopyEnqueueResult | undefined;
  try {
    if (queue.enqueueTracked) {
      queued = queue.enqueueTracked(accountKey, finalizeSentCopy);
    } else if (queue.enqueue) {
      const accepted = queue.enqueue(accountKey, async () => {
        await finalizeSentCopy();
      });
      queued = {
        accepted,
        jobId: "",
        state: accepted ? "pending" : "rejected",
        ...(!accepted ? { code: "QUEUE_FULL" } : {}),
      };
    }
  } catch {
    queued = undefined;
  }
  const accepted = queued?.accepted === true;
  if (!accepted) {
    console.warn("[bridge] Sent finalizer queue saturated; best-effort copy skipped");
    void spool.cleanup().catch(() => undefined);
  }
  return {
    ok: true,
    messageId: spool.messageId,
    sentCopySaved: false,
    sentCopyPending: accepted,
    ...(queued?.jobId ? { sentCopyJobId: queued.jobId } : {}),
    sentCopyState: queued?.state ?? "rejected",
    timings: { mimeSpoolMs, smtpMs },
  };
}

export async function sendMessage(
  account: MailAccount,
  password: string,
  payload: SendMessagePayload,
  deps: SendMessageDeps = defaultDeps(),
): Promise<SendMessageOk | SendMessageErr> {
  // Generate the MIME once into a bounded disk spool. SMTP and IMAP each
  // consume a fresh stream over the same byte-identical RFC822 file.
  let spool: MimeSpool;
  try {
    spool = await (deps.createMimeSpool ?? createMimeSpool)(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to build MIME";
    return { ok: false, error: msg };
  }

  try {
    // 1) SMTP send (single connection).
    const transporter = deps.createTransport(account, password);
    try {
      const envelopeRecipients = [...payload.to, ...(payload.cc || []), ...(payload.bcc || [])].map(
        (r) => r.email,
      );
      await withMimeSpoolReadStream(spool, (raw) =>
        transporter.sendMail({
          raw,
          envelope: { from: payload.from.email, to: envelopeRecipients },
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "فشل إرسال الرسالة";
      return { ok: false, error: msg };
    } finally {
      transporter.close();
    }

    // 2) Best-effort Sent copy. NEVER fails the send.
    let sentCopySaved = false;
    const client = deps.createImapSentClient(account, password);
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    try {
      await client.connect();
      const mailboxes = await client.list();
      const sentPath = resolveSentPath(mailboxes);
      if (sentPath) {
        // Search for our Message-ID with short retries — the provider may have
        // auto-saved a copy already (Gmail, most managed hosts).
        for (let i = 0; i < SENT_SEARCH_RETRIES; i++) {
          if (await client.searchMessageId(sentPath, spool.messageId)) {
            sentCopySaved = true;
            break;
          }
          if (i < SENT_SEARCH_RETRIES - 1) {
            await sleep(SENT_SEARCH_INTERVAL_MS);
          }
        }
        // No auto-saved copy → APPEND the exact MIME with \Seen.
        if (!sentCopySaved) {
          try {
            await client.append(sentPath, await readMimeSpoolBuffer(spool), ["\\Seen"]);
            sentCopySaved = true;
          } catch (appendErr) {
            const m = appendErr instanceof Error ? appendErr.message : String(appendErr);
            console.error("[bridge] APPEND to Sent failed:", m);
          }
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error("[bridge] Sent-copy step failed:", m);
    } finally {
      await client.logout().catch(() => {});
    }

    return { ok: true, messageId: spool.messageId, sentCopySaved };
  } finally {
    await spool.cleanup().catch(() => undefined);
  }
}
