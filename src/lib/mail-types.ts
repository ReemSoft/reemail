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
  id: string;
  filename: string;
  size: number; // bytes
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
}
