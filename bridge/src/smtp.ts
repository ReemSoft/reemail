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

async function buildMime(payload: SendMessagePayload): Promise<{ raw: Buffer; messageId: string }> {
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

  const mc = new MailComposer(composerOpts);
  const compiled = mc.compile();
  // Force messageId generation now so the same ID flows through SMTP + APPEND.
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
export async function sendMessage(
  account: MailAccount,
  password: string,
  payload: SendMessagePayload,
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
  const transporter = createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure,
    auth: { user: account.email_address, pass: password },
    tls: { rejectUnauthorized: false },
  });
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
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const sentPath = resolveSentPath(mailboxes);
    if (sentPath) {
      // Search for our Message-ID with short retries — the provider may have
      // auto-saved a copy already (Gmail, most managed hosts).
      for (let i = 0; i < SENT_SEARCH_RETRIES; i++) {
        if (await messageExistsInFolder(client, sentPath, messageId)) {
          sentCopySaved = true;
          break;
        }
        if (i < SENT_SEARCH_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, SENT_SEARCH_INTERVAL_MS));
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
