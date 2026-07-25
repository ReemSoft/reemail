import { ImapFlow, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { MailAccount, MailFolder, FolderCount, MailMessage } from "./types.js";

const IMAP_TIMEOUT_MS = 30_000;

const WELL_KNOWN_FOLDERS: Record<MailFolder, string[]> = {
  inbox: ["INBOX"],
  sent: ["Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail", "[Gmail]/Sent"],
  drafts: ["Drafts", "[Gmail]/Drafts"],
  spam: ["Spam", "Junk", "Junk E-mail", "[Gmail]/Spam"],
  trash: ["Trash", "Deleted", "Deleted Items", "[Gmail]/Trash", "[Gmail]/Bin"],
  archive: ["Archive", "[Gmail]/All Mail", "[Gmail]/Archive"],
  starred: ["Starred", "[Gmail]/Starred"],
  all: ["All Mail", "[Gmail]/All Mail"],
};

export function makeImapClient(account: MailAccount, password: string) {
  return new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure,
    auth: {
      user: account.email_address,
      pass: password,
    },
    logger: false,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS,
  });
}

export async function listMailboxes(client: ImapFlow): Promise<ListResponse[]> {
  const tree = await client.list();
  return tree;
}

export function resolveFolderPath(
  mailboxes: ListResponse[],
  folder: MailFolder,
): string | undefined {
  // Starred is not a real folder on most IMAP servers — it's the \Flagged
  // flag inside INBOX. Map it to INBOX so per-UID operations (mark read,
  // star/unstar, move, delete, fetch body) target the correct mailbox.
  if (folder === "starred") {
    const inbox = mailboxes.find((m) => m.path.toUpperCase() === "INBOX");
    if (inbox) return inbox.path;
    // Fall back to a real Starred mailbox if the server exposes one (Gmail).
    const gmailStarred = mailboxes.find((m) =>
      m.path.toLowerCase().includes("starred"),
    );
    if (gmailStarred) return gmailStarred.path;
    return "INBOX";
  }

  const candidates = WELL_KNOWN_FOLDERS[folder] || [];

  // Direct path match
  for (const name of candidates) {
    const found = mailboxes.find((m) => m.path.toLowerCase() === name.toLowerCase());
    if (found) return found.path;
  }

  // Case-insensitive includes match
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const found = mailboxes.find((m) => m.path.toLowerCase().includes(lower));
    if (found) return found.path;
  }

  // For "all" fallback to INBOX
  if (folder === "all") return "INBOX";

  return undefined;
}

export async function getFolderCounts(
  account: MailAccount,
  password: string,
): Promise<FolderCount[]> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);

    const allFolders: MailFolder[] = [
      "inbox",
      "starred",
      "sent",
      "drafts",
      "spam",
      "trash",
      "archive",
      "all",
    ];

    const counts: FolderCount[] = [];
    for (const folder of allFolders) {
      // Starred is a virtual folder (\Flagged in INBOX). Always supported.
      if (folder === "starred") {
        try {
          const inboxPath = resolveFolderPath(mailboxes, "inbox") || "INBOX";
          const lock = await client.getMailboxLock(inboxPath);
          try {
            const uids = (await client.search({ flagged: true } as SearchObject, { uid: true })) as number[];
            const unseen = (await client.search({ flagged: true, seen: false } as SearchObject, { uid: true })) as number[];
            counts.push({ folder, total: uids?.length ?? 0, unread: unseen?.length ?? 0, supported: true });
          } finally {
            lock.release();
          }
        } catch {
          counts.push({ folder, total: 0, unread: 0, supported: true });
        }
        continue;
      }

      // For `all`, only treat as supported if a real "All Mail" mailbox exists
      // (e.g. Gmail). Otherwise skip to avoid expensive cross-folder aggregation.
      if (folder === "all") {
        const allMailPath = mailboxes.find((m) =>
          /all\s*mail/i.test(m.path) || /\[Gmail\]\/All Mail/i.test(m.path),
        )?.path;
        if (!allMailPath) {
          counts.push({ folder, total: 0, unread: 0, supported: false });
          continue;
        }
        try {
          const status = await client.status(allMailPath, { messages: true, unseen: true });
          counts.push({
            folder,
            total: status.messages ?? 0,
            unread: status.unseen ?? 0,
            supported: true,
          });
        } catch {
          counts.push({ folder, total: 0, unread: 0, supported: false });
        }
        continue;
      }

      const path = resolveFolderPath(mailboxes, folder);
      if (!path) {
        // archive/etc. not present on the server → hide from the UI.
        counts.push({ folder, total: 0, unread: 0, supported: false });
        continue;
      }
      try {
        const status = await client.status(path, { messages: true, unseen: true });
        counts.push({
          folder,
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
          supported: true,
        });
      } catch {
        counts.push({ folder, total: 0, unread: 0, supported: true });
      }
    }
    return counts;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getMessages(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  options: { limit?: number; offset?: number } = {},
): Promise<MailMessage[]> {
  const client = makeImapClient(account, password);
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);

    // Starred is a flag, not a folder on most IMAP servers.
    // Fetch \Flagged messages from INBOX with proper pagination.
    if (folder === "starred") {
      const inboxPath = resolveFolderPath(mailboxes, "inbox") || "INBOX";
      const lock = await client.getMailboxLock(inboxPath);
      try {
        const uids = ((await client.search({ flagged: true } as SearchObject, { uid: true })) as number[]) || [];
        if (uids.length === 0) return [];
        // UIDs are ascending; newest last. Sort desc then paginate.
        const sorted = uids.slice().sort((a, b) => b - a);
        const slice = sorted.slice(offset, offset + limit);
        if (slice.length === 0) return [];

        const messages: MailMessage[] = [];
        for await (const msg of client.fetch(slice as any, {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyStructure: true,
        }, { uid: true })) {
          const parsed = await messageFromFetch(msg, folder, client);
          messages.push(parsed);
        }
        return messages.sort((a, b) => (a.date < b.date ? 1 : -1));
      } finally {
        lock.release();
      }
    }

    const path = resolveFolderPath(mailboxes, folder);
    if (!path) return [];

    const lock = await client.getMailboxLock(path);
    try {
      const total = (client.mailbox as any)?.exists ?? 0;
      if (total === 0) return [];

      const start = Math.max(1, total - offset - limit + 1);
      const end = total - offset;
      const range = `${start}:${end}`;

      const messages: MailMessage[] = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        internalDate: true,
        flags: true,
        bodyStructure: true,
      })) {
        const parsed = await messageFromFetch(msg, folder, client);
        messages.push(parsed);
      }
      if (messages.length === 0) return [];

      return messages.sort((a, b) => (a.date < b.date ? 1 : -1));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getMessageBody(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
): Promise<MailMessage | null> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) return null;

    const lock = await client.getMailboxLock(path);
    try {
      const msg = await client.fetchOne(
        uid.toString(),
        { uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true, source: true },
        { uid: true },
      );
      if (!msg) return null;

      const parsed = await parseMessageSource(msg.source as Buffer, folder);
      parsed.id = `${folder}:${uid}`;
      parsed.threadId = msg.envelope?.messageId || parsed.id;
      parsed.read = msg.flags?.has("\\Seen") || false;
      parsed.starred = msg.flags?.has("\\Flagged") || false;
      parsed.folder = folder;
      return parsed;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function messageFromFetch(
  msg: any,
  folder: MailFolder,
  client: ImapFlow,
): Promise<MailMessage> {
  const uid: number = msg.uid;
  const envelope = msg.envelope;
  const date = msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString();
  const hasAttachments = detectAttachments(msg.bodyStructure);

  const from = addressFromEnvelope(envelope?.from?.[0], accountEmail(client));
  const subject = envelope?.subject || "(بدون موضوع)";
  const preview = "";

  return {
    id: `${folder}:${uid}`,
    threadId: envelope?.messageId || `${folder}:${uid}`,
    folder,
    from,
    to: (envelope?.to || []).map((a: any) => addressFromEnvelope(a, "")),
    cc: (envelope?.cc || []).map((a: any) => addressFromEnvelope(a, "")),
    subject,
    preview,
    body: "",
    date,
    read: msg.flags?.has("\\Seen") || false,
    starred: msg.flags?.has("\\Flagged") || false,
    hasAttachments,
    attachments: undefined,
    labels: [],
  };
}

function accountEmail(client: ImapFlow): string {
  // ImapFlow does not expose the auth user directly; fallback placeholder.
  return (client as any).options?.auth?.user || "";
}

function addressFromEnvelope(addr: any, fallback: string): { name: string; email: string } {
  if (!addr) return { name: "", email: fallback };
  return {
    name: addr.name || "",
    email: addr.address || fallback,
  };
}

function detectAttachments(structure: any): boolean {
  if (!structure) return false;
  if (structure.type === "attachment") return true;
  if (Array.isArray(structure.childNodes)) {
    return structure.childNodes.some((c: any) => detectAttachments(c));
  }
  if (structure.childNodes) return detectAttachments(structure.childNodes);
  return false;
}

async function parseMessageSource(source: Buffer, folder: MailFolder): Promise<MailMessage> {
  const parsed = await simpleParser(source);
  return parsedMailToMessage(parsed, folder);
}

export function parsedMailToMessage(parsed: ParsedMail, folder: MailFolder): MailMessage {
  const from = parsed.from
    ? addressFromAddressObject(parsed.from)
    : { name: "", email: "" };
  const to = parsed.to ? addressesFromAddressObject(parsed.to) : [];
  const cc = parsed.cc ? addressesFromAddressObject(parsed.cc) : [];

  const body = parsed.html || parsed.textAsHtml || parsed.text || "";
  const preview = makePreview(parsed.text || parsed.subject || "");
  const hasAttachments = parsed.attachments && parsed.attachments.length > 0;
  const attachments = (parsed.attachments || []).map((a, i) => ({
    id: a.checksum || `att_${i}`,
    filename: a.filename || `attachment_${i}`,
    size: a.size,
    mimeType: a.contentType,
  }));

  const { mailedBy, signedBy, security } = extractSecurityHeaders(parsed);

  return {
    id: "",
    threadId: parsed.messageId || "",
    folder,
    from,
    to,
    cc,
    subject: parsed.subject || "(بدون موضوع)",
    preview,
    body,
    date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
    read: parsed.flags?.includes("\\Seen") || false,
    starred: parsed.flags?.includes("\\Flagged") || false,
    hasAttachments,
    attachments,
    labels: [],
    mailedBy,
    signedBy,
    security,
  };
}

function headerValue(parsed: ParsedMail, name: string): string {
  const raw = parsed.headers?.get(name.toLowerCase());
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === "string" ? v : "")).join(" ");
  if (typeof (raw as any).value === "string") return (raw as any).value;
  return "";
}

function headerLines(parsed: ParsedMail, name: string): string[] {
  const target = name.toLowerCase();
  const lines = (parsed.headerLines || []).filter((l: any) => l?.key === target);
  return lines.map((l: any) => String(l.line || "").replace(/^[^:]*:\s*/i, ""));
}

function extractSecurityHeaders(parsed: ParsedMail): {
  mailedBy?: string;
  signedBy?: string;
  security?: string;
} {
  // signed-by: DKIM d=domain
  let signedBy: string | undefined;
  const dkim = headerLines(parsed, "DKIM-Signature").join(" ");
  const dMatch = dkim.match(/(?:^|;|\s)d=([^;\s]+)/i);
  if (dMatch) signedBy = dMatch[1].toLowerCase();

  // mailed-by: from Return-Path domain, or from first Received "by <host>"
  let mailedBy: string | undefined;
  const returnPath = headerValue(parsed, "Return-Path");
  const rpMatch = returnPath.match(/@([A-Za-z0-9.-]+)/);
  if (rpMatch) mailedBy = rpMatch[1].toLowerCase();
  if (!mailedBy) {
    const received = headerLines(parsed, "Received");
    const first = received[received.length - 1] || received[0] || "";
    const byMatch = first.match(/\bby\s+([A-Za-z0-9.-]+)/i);
    if (byMatch) mailedBy = byMatch[1].toLowerCase();
  }

  // security: infer TLS from Received "with ESMTPS" / "using TLS"
  let security: string | undefined;
  const receivedAll = headerLines(parsed, "Received").join(" ");
  if (/\b(ESMTPS|ESMTPSA)\b/i.test(receivedAll) || /\busing TLS/i.test(receivedAll)) {
    const versionMatch = receivedAll.match(/\b(TLS(?:v?1\.\d)?)\b/i);
    security = versionMatch ? `مشفّر (${versionMatch[1].toUpperCase()})` : "مشفّر (TLS)";
  } else if (receivedAll) {
    security = "غير مشفّر";
  }

  return { mailedBy, signedBy, security };
}


function flattenAddressObject(obj: AddressObject | AddressObject[]): { name: string; email: string }[] {
  const arr = Array.isArray(obj) ? obj : [obj];
  const out: { name: string; email: string }[] = [];
  for (const item of arr) {
    if (!item) continue;
    const values = (item as any).value as Array<{ name?: string; address?: string; group?: any[] }> | undefined;
    if (Array.isArray(values) && values.length) {
      for (const v of values) {
        if (v?.address || v?.name) {
          out.push({ name: v.name || "", email: v.address || "" });
        }
      }
    } else if ((item as any).address || (item as any).name) {
      out.push({ name: (item as any).name || "", email: (item as any).address || "" });
    }
  }
  return out;
}

function addressFromAddressObject(obj: AddressObject): { name: string; email: string } {
  return flattenAddressObject(obj)[0] || { name: "", email: "" };
}

function addressesFromAddressObject(obj: AddressObject | AddressObject[]): { name: string; email: string }[] {
  return flattenAddressObject(obj);
}

function makePreview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
}

export async function markRead(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  read: boolean,
): Promise<void> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) throw new Error("Folder not found");
    const lock = await client.getMailboxLock(path);
    try {
      if (read) {
        await client.messageFlagsAdd({ uid: [uid] } as any, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove({ uid: [uid] } as any, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function starMessage(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  starred: boolean,
): Promise<void> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) throw new Error("Folder not found");
    const lock = await client.getMailboxLock(path);
    try {
      if (starred) {
        await client.messageFlagsAdd({ uid: [uid] } as any, ["\\Flagged"], { uid: true });
      } else {
        await client.messageFlagsRemove({ uid: [uid] } as any, ["\\Flagged"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function moveMessage(
  account: MailAccount,
  password: string,
  fromFolder: MailFolder,
  uid: number,
  toFolder: MailFolder,
): Promise<void> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const fromPath = resolveFolderPath(mailboxes, fromFolder);
    const toPath = resolveFolderPath(mailboxes, toFolder);
    if (!fromPath || !toPath) throw new Error("Folder not found");
    const lock = await client.getMailboxLock(fromPath);
    try {
      await client.messageMove({ uid: [uid] } as any, toPath, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function deleteMessage(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
): Promise<void> {
  await moveMessage(account, password, folder, uid, "trash");
}

export async function verifyCredentials(
  account: MailAccount,
  password: string,
): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    return { ok: true, displayName: account.display_name || account.email_address };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.responseText || err?.message || "فشل الاتصال بخادم البريد",
    };
  } finally {
    await client.logout().catch(() => {});
  }
}
