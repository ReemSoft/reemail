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
  filename: string;
  size: number;
  mimeType: string;
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
}

export interface FolderCount {
  folder: MailFolder;
  total: number;
  unread: number;
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
