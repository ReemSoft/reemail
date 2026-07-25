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
  folder: MailFolder;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  preview: string;
  body: string; // HTML or plain
  date: string; // ISO
  read: boolean;
  starred: boolean;
  hasAttachments: boolean;
  attachments?: MailAttachment[];
  labels?: string[];
  mailedBy?: string;
  signedBy?: string;
  security?: string;
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
}
