// In-browser session for the email owner ("client").
// Password is kept only in sessionStorage — cleared on tab close or sign-out.

export interface MailSessionAccount {
  id: string;
  company_id: string;
  email_address: string;
  display_name: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
}

export interface MailSessionCompany {
  id: string;
  name: string;
  app_name: string | null;
  logo_url: string | null;
  brand_primary: string;
  brand_accent: string;
}

export interface MailSession {
  account: MailSessionAccount;
  company: MailSessionCompany | null;
  password: string;
}

const KEY = "reemsoft.mail.session";

export function saveMailSession(session: MailSession) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(KEY, JSON.stringify(session));
}

export function getMailSession(): MailSession | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MailSession;
  } catch {
    return null;
  }
}

export function clearMailSession() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(KEY);
}
