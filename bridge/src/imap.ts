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
    ];

    const counts: FolderCount[] = [];
    for (const folder of allFolders) {
      const path = resolveFolderPath(mailboxes, folder);
      if (!path) {
        counts.push({ folder, total: 0, unread: 0 });
        continue;
      }
      try {
        const status = await client.status(path, { messages: true, unseen: true });
        counts.push({
          folder,
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
        });
      } catch {
        counts.push({ folder, total: 0, unread: 0 });
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
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) return [];

    const lock = await client.getMailboxLock(path);
    try {
      const total = (client.mailbox as any)?.exists ?? 0;
      if (total === 0) return [];

      const start = Math.max(1, total - offset - limit + 1);
      const end = total - offset;
      const range = `${start}:${end}`;

      const ids: number[] = [];
      for await (const msg of client.fetch(range, { uid: true, envelope: true, flags: true })) {
        ids.push(msg.uid);
      }
      if (ids.length === 0) return [];

      // Fetch structure for attachment detection
      const messages: MailMessage[] = [];
      for await (const msg of client.fetch(
        { uid: ids, all: true } as any,
        { uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true },
      )) {
        const parsed = await messageFromFetch(msg, folder, client);
        messages.push(parsed);
      }

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
      parsed.read = !msg.flags?.has("\\Seen");
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
    read: !msg.flags?.has("\\Seen"),
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
    read: !parsed.flags?.includes("\\Seen"),
    starred: parsed.flags?.includes("\\Flagged") || false,
    hasAttachments,
    attachments,
    labels: [],
  };
}

function addressFromAddressObject(obj: AddressObject): { name: string; email: string } {
  const first = Array.isArray(obj) ? obj[0] : obj;
  if (!first) return { name: "", email: "" };
  return {
    name: first.name || "",
    email: first.address || "",
  };
}

function addressesFromAddressObject(obj: AddressObject | AddressObject[]): { name: string; email: string }[] {
  const arr = Array.isArray(obj) ? obj : [obj];
  return arr.map((a) => addressFromAddressObject(a));
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
