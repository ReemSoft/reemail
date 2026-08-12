// Shared mail domain types. Same shape the future Node backend will return.

export type MailFolder =
  | "inbox"
  | "starred"
  | "sent"
  | "drafts"
  | "spam"
  | "trash"
  | "archive"
  | "all";

export interface MailAddress {
  name: string;
  email: string;
}

export interface MailAttachment {
  /** Legacy id (checksum / index). Kept for compat; not usable for IMAP fetch. */
  id: string;
  /** IMAP BODYSTRUCTURE part number (e.g. "2", "1.2"). Required for download. */
  part?: string;
  filename: string;
  size: number; // bytes
  mimeType: string;
  disposition?: "attachment" | "inline" | string;
  contentId?: string;
}

export interface MailMessage {
  id: string;
  threadId: string;
  /** RFC Message-ID of the direct parent, when this message is a reply. */
  inReplyTo?: string;
  /** RFC References chain, oldest to newest. */
  references?: string[];
  /** RFC Reply-To addresses already present in the fetched message headers. */
  replyTo?: MailAddress[];
  folder: MailFolder;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  preview: string;
  body: string; // HTML or plain
  /** True when only the bounded initial portion of the selected body was returned. */
  bodyTruncated?: boolean;
  date: string; // ISO
  read: boolean;
  starred: boolean;
  hasAttachments: boolean;
  attachments?: MailAttachment[];
  labels?: string[];
  mailedBy?: string;
  signedBy?: string;
  security?: string;
  /**
   * X-MailMaestro-Draft-ID header value — present only on drafts that were
   * previously saved by MailMaestro. Populated by the bridge when reading a
   * Drafts folder message. Absent on legacy drafts and non-draft mail.
   */
  draftIdHeader?: string;
  /**
   * IMAP UIDVALIDITY captured while the mailbox was open for this fetch.
   * Used by the composer to build a trustworthy `previousRef` when opening
   * a Drafts folder message for edit.
   */
  uidValidity?: string;
  /** Referenced CID parts resolved later through one protected batch. */
  inlineParts?: { cid: string; part: string; mimeType: string; size: number }[];
  /** CID image bytes returned by the batch or the existing body cache. */
  inlineImages?: { cid: string; part: string; mimeType: string; size: number; dataUri: string }[];
}

export interface FolderCount {
  folder: MailFolder;
  total: number;
  unread: number;
  /**
   * Whether the folder is actually available on the underlying mail server.
   * `starred` is a virtual folder (\Flagged in INBOX) and is always supported.
   * `archive` / `all` are only supported when a matching mailbox exists.
   */
  supported?: boolean;
  /**
   * Real IMAP mailbox path resolved by the bridge (e.g. "INBOX",
   * "[Gmail]/Sent Mail"). Used to drive Local Mail Index sync without
   * guessing folder names on the client.
   */
  path?: string;
}
