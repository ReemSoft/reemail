// Shared types between bridge and Lovable frontend.

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
  id: string;
  /** IMAP BODYSTRUCTURE part number (e.g. "2", "1.2"). */
  part?: string;
  filename: string;
  size: number;
  mimeType: string;
  disposition?: string;
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
  body: string;
  date: string;
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
   * Whether this folder actually exists / is available on the underlying mail
   * server. `starred` is always virtual (via \Flagged in INBOX) and reported
   * as supported. `archive` and `all` are only supported if a matching
   * mailbox exists on the server.
   */
  supported: boolean;
  /**
   * Real IMAP mailbox path resolved on the server (e.g. "INBOX",
   * "[Gmail]/Sent Mail"). Absent when `supported === false` and no path
   * could be resolved. Used by the Local Mail Index sync so we never
   * guess folder names on the client.
   */
  path?: string;
}

export interface MailAccount {
  email_address: string;
  display_name?: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
}

export interface AuthPayload {
  account: MailAccount;
  password: string;
}
