/**
 * MAILMAESTRO_IMAP_SINGLE_CONNECTION
 *
 * ONE reusable IMAP connection per active account (NOT a pool, NOT a
 * connection per folder). Standard behaviour of desktop mail clients:
 *
 *   * the TCP + TLS + LOGIN handshake happens once per account, then every
 *     subsequent request rides the same authenticated session
 *   * requests are serialized per account with `getMailboxLock`
 *   * the connection is closed with `logout()` after 5 minutes of idleness
 *   * a single transparent reconnect + retry when the socket is dead
 *   * the LIST response is cached for 5 minutes per account
 *
 * Nothing here changes any API contract: callers still hand us an account +
 * password and get an ImapFlow client with the requested mailbox locked.
 */
import { ImapFlow, type ListResponse } from "imapflow";
import type { MailAccount } from "./types.js";

const IMAP_TIMEOUT_MS = 30_000;

/** Local client factory (kept here to avoid a cycle with imap.ts). */
function makeImapClient(account: MailAccount, password: string) {
  return new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure,
    auth: { user: account.email_address, pass: password },
    logger: false,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS,
  });
}

const IDLE_CLOSE_MS = Number(process.env.IMAP_CONN_IDLE_MS || 5 * 60_000);
const LIST_CACHE_MS = Number(process.env.IMAP_LIST_CACHE_MS || 5 * 60_000);

export const TIMING_ENABLED = /^(1|true|yes|on)$/i.test(process.env.MAIL_BRIDGE_TIMING || "");

interface Entry {
  client: ImapFlow;
  /** Serializes every operation that runs on this shared connection. */
  chain: Promise<unknown>;
  idleTimer?: NodeJS.Timeout;
  mailboxes?: { at: number; value: ListResponse[] };
  /** Credential fingerprint — a password change forces a fresh connection. */
  fingerprint: string;
}

const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();

/**
 * Connection lanes. At most TWO connections per active account:
 *   * interactive — everything the user started (opening a message, flags…)
 *   * background  — sync + body-cache warming
 * Each lane serializes its own commands, but the background lane NEVER
 * enters the interactive chain, so a warm-up can not delay a click.
 */
export type ImapLane = "interactive" | "background";

/** Account identity key. Host + user + lane only — never logged. */
function keyFor(account: MailAccount, lane: ImapLane = "interactive"): string {
  return `${lane}|${account.imap_host.toLowerCase().trim()}:${account.imap_port}:${account.email_address.toLowerCase().trim()}`;
}

function fingerprintFor(account: MailAccount, password: string): string {
  // Cheap non-reversible-enough marker so a rotated password invalidates the
  // cached session. Never exposed anywhere.
  let h = 0;
  const s = `${account.imap_secure}|${password}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

function armIdleTimer(key: string, entry: Entry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entries.get(key) === entry) entries.delete(key);
    entry.client.logout().catch(() => {});
  }, IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

function dropEntry(key: string, entry: Entry) {
  if (entries.get(key) === entry) entries.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.client.logout().catch(() => {
    try {
      entry.client.close();
    } catch {
      /* already gone */
    }
  });
}

async function openEntry(
  key: string,
  account: MailAccount,
  password: string,
  lane: ImapLane = "interactive",
): Promise<Entry> {
  const existing = pending.get(key);
  if (existing) return existing;
  const p = (async () => {
    const client = makeImapClient(account, password);
    const t0 = Date.now();
    await client.connect();
    if (TIMING_ENABLED) console.log(`[imap-timing] lane=${lane} connect ${Date.now() - t0}ms`);
    const entry: Entry = {
      client,
      chain: Promise.resolve(),
      fingerprint: fingerprintFor(account, password),
    };
    const onGone = () => {
      if (entries.get(key) === entry) entries.delete(key);
    };
    client.on("close", onGone);
    client.on("error", onGone);
    entries.set(key, entry);
    armIdleTimer(key, entry);
    return entry;
  })();
  pending.set(key, p);
  try {
    return await p;
  } finally {
    pending.delete(key);
  }
}

async function getEntry(
  account: MailAccount,
  password: string,
  lane: ImapLane = "interactive",
): Promise<Entry> {
  const key = keyFor(account, lane);
  const fp = fingerprintFor(account, password);
  const cached = entries.get(key);
  if (cached) {
    if (cached.fingerprint !== fp || !cached.client.usable) {
      dropEntry(key, cached);
    } else {
      armIdleTimer(key, cached);
      return cached;
    }
  }
  return openEntry(key, account, password, lane);
}

/** Cached LIST per account (5 min). Invalidated on reconnect. */
export async function getMailboxesCached(
  account: MailAccount,
  password: string,
  lane: ImapLane = "interactive",
): Promise<ListResponse[]> {
  const entry = await getEntry(account, password, lane);
  const now = Date.now();
  if (entry.mailboxes && now - entry.mailboxes.at < LIST_CACHE_MS) return entry.mailboxes.value;
  const t0 = Date.now();
  const value = await entry.client.list();
  if (TIMING_ENABLED) console.log(`[imap-timing] lane=${lane} list ${Date.now() - t0}ms`);
  entry.mailboxes = { at: Date.now(), value };
  return value;
}

export function invalidateMailboxCache(account: MailAccount) {
  for (const lane of ["interactive", "background"] as ImapLane[]) {
    const e = entries.get(keyFor(account, lane));
    if (e) e.mailboxes = undefined;
  }
}

/**
 * Drops the cached connection for an account (poisoned socket: a body stream
 * errored or was destroyed mid-literal). The next request reconnects cleanly.
 */
export function dropAccountConnection(account: MailAccount, lane?: ImapLane): void {
  const lanes: ImapLane[] = lane ? [lane] : ["interactive", "background"];
  for (const l of lanes) {
    const key = keyFor(account, l);
    const e = entries.get(key);
    if (e) dropEntry(key, e);
  }
}

function isConnectionError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || "").toLowerCase();
  const code = String((err as any)?.code || "").toUpperCase();
  return (
    code === "NOCONNECTION" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    msg.includes("connection not available") ||
    msg.includes("connection closed") ||
    msg.includes("socket") ||
    msg.includes("not connected")
  );
}

/**
 * Runs `fn` on the shared per-account connection with `path` locked.
 * Operations on the same account are serialized (IMAP is single-command).
 * One transparent reconnect + retry when the socket died.
 */
export async function withAccountMailbox<T>(
  account: MailAccount,
  password: string,
  path: string,
  fn: (client: ImapFlow) => Promise<T>,
  lane: ImapLane = "interactive",
): Promise<T> {
  const key = keyFor(account, lane);

  const runOnce = async (): Promise<T> => {
    const entry = await getEntry(account, password, lane);
    // Serialize per connection: chain onto the previous operation.
    const run = entry.chain.then(
      async () => {
        const tLock = Date.now();
        const lock = await entry.client.getMailboxLock(path);
        if (TIMING_ENABLED)
          console.log(`[imap-timing] lane=${lane} select ${Date.now() - tLock}ms`);
        try {
          return await fn(entry.client);
        } finally {
          lock.release();
          armIdleTimer(key, entry);
        }
      },
      async () => {
        // Previous op failed — the chain must not stay rejected.
        const e2 = await getEntry(account, password, lane);
        const lock = await e2.client.getMailboxLock(path);
        try {
          return await fn(e2.client);
        } finally {
          lock.release();
          armIdleTimer(key, e2);
        }
      },
    );
    entry.chain = run.catch(() => undefined);
    return run;
  };

  try {
    return await runOnce();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const stale = entries.get(key);
    if (stale) dropEntry(key, stale);
    return runOnce();
  }
}

/** Closes every open connection (SIGTERM / SIGINT / tests). */
export async function closeAllImapConnections(): Promise<void> {
  const all = [...entries.entries()];
  entries.clear();
  await Promise.all(
    all.map(async ([, e]) => {
      if (e.idleTimer) clearTimeout(e.idleTimer);
      await e.client.logout().catch(() => {});
    }),
  );
}

/** Bounded, PII-free stats for /api/health style surfaces. */
export function imapConnectionStats() {
  const lanes = { interactive: 0, background: 0 };
  for (const k of entries.keys()) {
    if (k.startsWith("background|")) lanes.background++;
    else lanes.interactive++;
  }
  return {
    openConnections: entries.size,
    lanes,
    maxConnectionsPerAccount: 2,
    idleCloseMs: IDLE_CLOSE_MS,
    listCacheMs: LIST_CACHE_MS,
  };
}
