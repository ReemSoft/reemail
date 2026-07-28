import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ImapFlow, ListResponse } from "imapflow";
import { makeImapClient, listMailboxes } from "./imap.js";
import type { MailAccount } from "./types.js";

export interface SendAttachment {
  filename: string;
  /** In-memory bytes. Prefer `path` for anything > a few KB. */
  content?: Buffer;
  /** On-disk path — nodemailer streams it, keeping RSS flat. */
  path?: string;
  contentType?: string;
}

export interface SendMessagePayload {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  bcc?: { name: string; email: string }[];
  subject: string;
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

const SENT_SEARCH_RETRIES = 3;
const SENT_SEARCH_INTERVAL_MS = 500;

/**
 * Resolve the true Sent folder path using IMAP SPECIAL-USE first, then well-
 * known names that actually exist in the LIST response. Returns undefined if
 * no suitable Sent mailbox is present — never creates one.
 */
export function resolveSentPath(mailboxes: ListResponse[]): string | undefined {
  // 1) SPECIAL-USE \Sent (RFC 6154)
  for (const mb of mailboxes) {
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
    const found = mailboxes.find((m) => m.path.toLowerCase() === name.toLowerCase());
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
  try {
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
  } catch {
    return false;
  }
}

/**
 * Build a MIME message. Optional `extraHeaders` are injected as top-level
 * headers on the outer message (used by the drafts flow to stamp
 * `X-MailMaestro-Draft-ID` so IMAP header search can locate the copy for
 * idempotent APPEND + selective delete). Exported for the drafts module and
 * the drafts test suite; not part of the public HTTP contract.
 */
export async function buildMime(
  payload: SendMessagePayload,
  extraHeaders?: Record<string, string>,
): Promise<{ raw: Buffer; messageId: string }> {
  const composerOpts: Record<string, unknown> = {
    from: payload.from.name ? `"${payload.from.name}" <${payload.from.email}>` : payload.from.email,
    to: payload.to.map((t) => (t.name ? `"${t.name}" <${t.email}>` : t.email)).join(", "),
    subject: payload.subject,
    text: payload.bodyText || "",
    html: payload.bodyHtml || "",
  };
  if (payload.cc && payload.cc.length > 0) {
    composerOpts.cc = payload.cc
      .map((c) => (c.name ? `"${c.name}" <${c.email}>` : c.email))
      .join(", ");
  }
  if (payload.bcc && payload.bcc.length > 0) {
    composerOpts.bcc = payload.bcc
      .map((b) => (b.name ? `"${b.name}" <${b.email}>` : b.email))
      .join(", ");
  }
  if (payload.attachments && payload.attachments.length > 0) {
    composerOpts.attachments = payload.attachments.map((a) => ({
      filename: a.filename,
      ...(a.path ? { path: a.path } : { content: a.content }),
      contentType: a.contentType,
    }));
  }
  if (extraHeaders && Object.keys(extraHeaders).length > 0) {
    composerOpts.headers = { ...extraHeaders };
  }

  const mc = new MailComposer(composerOpts);
  const compiled = mc.compile();
  const messageId: string = compiled.messageId();
  const raw: Buffer = await new Promise((resolve, reject) => {
    compiled.build((err: Error | null, msg: Buffer) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });
  return { raw, messageId };
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
  sendMail(opts: { raw: Buffer; envelope: { from: string; to: string[] } }): Promise<unknown>;
  close(): void;
}
export interface ImapSentClient {
  connect(): Promise<void>;
  list(): Promise<ListResponse[]>;
  searchMessageId(folderPath: string, messageId: string): Promise<boolean>;
  append(folderPath: string, raw: Buffer, flags: string[]): Promise<void>;
  logout(): Promise<void>;
}
export interface SendMessageDeps {
  createTransport: (account: MailAccount, password: string) => SmtpTransport;
  createImapSentClient: (account: MailAccount, password: string) => ImapSentClient;
  sleep?: (ms: number) => Promise<void>;
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
        tls: { rejectUnauthorized: false },
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
          await client.append(folderPath, raw, flags);
        },
        logout: () => client.logout().catch(() => {}) as unknown as Promise<void>,
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export async function sendMessage(
  account: MailAccount,
  password: string,
  payload: SendMessagePayload,
  deps: SendMessageDeps = defaultDeps(),
): Promise<SendMessageOk | SendMessageErr> {
  // Build the MIME once so SMTP send and IMAP APPEND use byte-identical bytes.
  let raw: Buffer;
  let messageId: string;
  try {
    ({ raw, messageId } = await buildMime(payload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to build MIME";
    return { ok: false, error: msg };
  }

  // 1) SMTP send (single connection).
  const transporter = deps.createTransport(account, password);
  try {
    const envelopeRecipients = [...payload.to, ...(payload.cc || []), ...(payload.bcc || [])].map(
      (r) => r.email,
    );
    await transporter.sendMail({
      raw,
      envelope: { from: payload.from.email, to: envelopeRecipients },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "فشل إرسال الرسالة";
    transporter.close();
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
        if (await client.searchMessageId(sentPath, messageId)) {
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
          await client.append(sentPath, raw, ["\\Seen"]);
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

  return { ok: true, messageId, sentCopySaved };
}
