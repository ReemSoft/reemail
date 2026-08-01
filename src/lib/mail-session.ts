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
  /** Short-lived signed JWT bound to the permanent mail_accounts.id. */
  mailSessionToken?: string;
  /** Unix seconds. */
  mailSessionTokenExpiresAt?: number;
}

const KEY = "mailmaestro.mail.session";
/** Phase B: pool of mailboxes signed in during this tab (active + linked). */
const POOL_KEY = "mailmaestro.mail.mailboxes";

export function saveMailSession(session: MailSession) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(KEY, JSON.stringify(session));
  upsertPooledMailbox(session);
}

/** All mailboxes whose password is available in this tab. */
export function listPooledMailboxes(): MailSession[] {
  if (typeof window === "undefined") return [];
  const raw = sessionStorage.getItem(POOL_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MailSession[]) : [];
  } catch {
    return [];
  }
}

export function upsertPooledMailbox(session: MailSession) {
  if (typeof window === "undefined") return;
  const pool = listPooledMailboxes().filter((s) => s.account.id !== session.account.id);
  pool.push(session);
  sessionStorage.setItem(POOL_KEY, JSON.stringify(pool));
}

export function removePooledMailbox(accountId: string) {
  if (typeof window === "undefined") return;
  const pool = listPooledMailboxes().filter((s) => s.account.id !== accountId);
  sessionStorage.setItem(POOL_KEY, JSON.stringify(pool));
}

/** Makes `session` the active mailbox (and keeps it in the pool). */
export function setActiveMailbox(session: MailSession) {
  saveMailSession(session);
}


export function getMailSession(): MailSession | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MailSession;
    // Legacy sessions predating mailSessionToken are still usable for the
    // existing bridge flow; downstream sync code must treat missing token as
    // "needs re-login" rather than crashing.
    return parsed;
  } catch {
    return null;
  }
}

export function clearMailSession() {
  if (typeof window === "undefined") return;
  // Wipes password + token together — for the active mailbox AND every
  // linked mailbox signed in during this tab.
  sessionStorage.removeItem(KEY);
  sessionStorage.removeItem(POOL_KEY);
}


/**
 * Replaces ONLY the token pair after a silent renewal. Keeps the password and
 * account/company payload untouched. No-op when there is no live session.
 */
export function updateMailSessionToken(token: string, expiresAt: number): MailSession | null {
  const current = getMailSession();
  if (!current) return null;
  const next: MailSession = {
    ...current,
    mailSessionToken: token,
    mailSessionTokenExpiresAt: expiresAt,
  };
  saveMailSession(next);
  return next;
}
