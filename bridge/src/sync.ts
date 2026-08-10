/**
 * Bridge Sync Endpoints — Stage 3 (Local Mail Index).
 *
 * Read-only metadata sync helpers on top of IMAP. NEVER fetches body / HTML /
 * source / headers / attachment content. NEVER writes to any database.
 *
 * Exposes three logical operations consumed by /api/sync/{initial,incremental,
 * reconcile}: initial window fetch, incremental delta (new UIDs + optional
 * CONDSTORE flag deltas), and bounded reconcile (flags-only over a UID range).
 *
 * Pure helpers (detectHasAttachments, normalizeAddress, normalizeMessage,
 * schemas) are exported for unit testing.
 */

import { ImapFlow, type FetchMessageObject, type MessageStructureObject, type MessageAddressObject } from "imapflow";
import { z } from "zod";
import { makeImapClient } from "./imap.js";
import type { MailAccount } from "./types.js";

// --------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------

const V1_MAX_MESSAGES = 300;
const V1_MAX_RECONCILE_RANGE = 1000;
const DECIMAL_STRING = /^[0-9]{1,20}$/;

/** IMAP system flags that must NOT appear in the exported `keywords` array. */
export const SYSTEM_FLAGS = new Set<string>([
  "\\Seen",
  "\\Flagged",
  "\\Answered",
  "\\Draft",
  "\\Deleted",
  "\\Recent",
]);

// --------------------------------------------------------------------
// Types (normalized wire contract, metadata only)
// --------------------------------------------------------------------

export interface SyncAddress {
  name: string | null;
  email: string;
}

export interface SyncMessage {
  uid: number;
  modseq: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: SyncAddress | null;
  to: SyncAddress[];
  cc: SyncAddress[];
  internalDate: string;
  sizeBytes: number | null;
  hasAttachments: boolean;
  flagSeen: boolean;
  flagFlagged: boolean;
  flagAnswered: boolean;
  flagDraft: boolean;
  keywords: string[];
}

export interface SyncFlagState {
  uid: number;
  modseq: string | null;
  flagSeen: boolean;
  flagFlagged: boolean;
  flagAnswered: boolean;
  flagDraft: boolean;
  keywords: string[];
}

export interface SyncMailboxState {
  path: string;
  exists: number;
  uidValidity: string;
  uidNext: number | null;
  highestModseq: string | null;
}

// --------------------------------------------------------------------
// Zod schemas — strict, bounded
// --------------------------------------------------------------------

/**
 * NOTE: The nested AccountSchema is intentionally NOT strict so it stays
 * source-compatible with the existing bridge routes (which pass through
 * extra client-side fields such as id/company_id). Top-level payloads
 * ARE strict.
 */
const AccountSchema = z.object({
  email_address: z.string().email().max(320),
  display_name: z.string().max(200).nullable().optional(),
  imap_host: z.string().min(1).max(255),
  imap_port: z.number().int().positive().max(65535),
  imap_secure: z.boolean().default(true),
  smtp_host: z.string().min(1).max(255),
  smtp_port: z.number().int().positive().max(65535),
  smtp_secure: z.boolean().default(true),
});

const FolderPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !/[\r\n\0]/.test(v), "folderPath contains control chars");

const DecimalStringSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(DECIMAL_STRING, "must be a decimal string");

const NonNegUidSchema = z.number().int().min(0).max(4294967295).finite();
const PosUidSchema = z.number().int().min(1).max(4294967295).finite();

export const InitialSyncSchema = z
  .object({
    account: AccountSchema,
    password: z.string().min(1).max(1024),
    folderPath: FolderPathSchema,
    limit: z.number().int().positive().max(V1_MAX_MESSAGES).finite().default(V1_MAX_MESSAGES),
  })
  .strict();

export const IncrementalSyncSchema = z
  .object({
    account: AccountSchema,
    password: z.string().min(1).max(1024),
    folderPath: FolderPathSchema,
    expectedUidValidity: DecimalStringSchema.optional(),
    sinceUid: NonNegUidSchema,
    sinceModseq: DecimalStringSchema.optional(),
    flagsFromUid: PosUidSchema.optional(),
    flagsToUid: PosUidSchema.optional(),
    limit: z.number().int().positive().max(V1_MAX_MESSAGES).finite().default(V1_MAX_MESSAGES),
  })
  .strict()
  .refine(
    (v) => (v.flagsFromUid == null && v.flagsToUid == null) || (v.flagsFromUid != null && v.flagsToUid != null),
    { message: "flagsFromUid and flagsToUid must both be provided together" },
  )
  .refine(
    (v) => v.flagsFromUid == null || v.flagsToUid == null || v.flagsToUid >= v.flagsFromUid,
    { message: "flagsToUid must be >= flagsFromUid" },
  )
  .refine(
    (v) => v.flagsFromUid == null || v.flagsToUid == null || v.flagsToUid - v.flagsFromUid + 1 <= V1_MAX_RECONCILE_RANGE,
    { message: `flag range too large (max ${V1_MAX_RECONCILE_RANGE})` },
  );

export const ReconcileSyncSchema = z
  .object({
    account: AccountSchema,
    password: z.string().min(1).max(1024),
    folderPath: FolderPathSchema,
    expectedUidValidity: DecimalStringSchema,
    fromUid: PosUidSchema,
    toUid: PosUidSchema,
  })
  .strict()
  .refine((v) => v.toUid >= v.fromUid, { message: "toUid must be >= fromUid" })
  .refine((v) => v.toUid - v.fromUid + 1 <= V1_MAX_RECONCILE_RANGE, {
    message: `reconcile range too large (max ${V1_MAX_RECONCILE_RANGE})`,
  });

// --------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------

export function bigIntToDecimalString(v: bigint | number | undefined | null): string | null {
  if (v == null) return null;
  try {
    return typeof v === "bigint" ? v.toString(10) : String(v);
  } catch {
    return null;
  }
}

export function toIsoDate(v: Date | string | undefined | null): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: epoch. Metadata always carries some date; this is a safety net
  // for malformed server responses. Downstream code can detect epoch.
  return new Date(0).toISOString();
}

export function normalizeAddress(a: MessageAddressObject | null | undefined): SyncAddress | null {
  if (!a || typeof a.address !== "string") return null;
  const email = a.address.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  const nameRaw = typeof a.name === "string" ? a.name.trim() : "";
  return { name: nameRaw.length ? nameRaw : null, email };
}

/**
 * Walks the BODYSTRUCTURE tree. A message has an attachment when at least one
 * leaf part signals `attachment` disposition, or carries a filename (either in
 * disposition params or Content-Type params — this catches inline images that
 * users treat as attachments too).
 */
export function detectHasAttachments(structure: MessageStructureObject | undefined | null): boolean {
  if (!structure) return false;
  const walk = (node: MessageStructureObject | undefined | null): boolean => {
    if (!node) return false;
    const children = node.childNodes;
    if (Array.isArray(children) && children.length > 0) {
      for (const c of children) if (walk(c)) return true;
      return false;
    }
    // Leaf part
    const disp = (node.disposition || "").toLowerCase();
    if (disp === "attachment") return true;
    const dispParams = node.dispositionParameters || {};
    if (typeof dispParams.filename === "string" && dispParams.filename.trim().length > 0) return true;
    const params = node.parameters || {};
    if (
      (typeof params.name === "string" && params.name.trim().length > 0) ||
      (typeof params.filename === "string" && params.filename.trim().length > 0)
    ) {
      return true;
    }
    return false;
  };
  return walk(structure);
}

export function extractKeywords(flags: Iterable<string> | undefined | null): string[] {
  if (!flags) return [];
  const out: string[] = [];
  for (const f of flags) if (!SYSTEM_FLAGS.has(f)) out.push(f);
  return out;
}

export function normalizeMessage(m: FetchMessageObject): SyncMessage {
  const flagsSet = m.flags instanceof Set ? m.flags : new Set<string>(m.flags ?? []);
  const env = m.envelope ?? {};
  const from = env.from && env.from[0] ? normalizeAddress(env.from[0]) : null;
  const to = (env.to ?? []).map(normalizeAddress).filter((v): v is SyncAddress => v !== null);
  const cc = (env.cc ?? []).map(normalizeAddress).filter((v): v is SyncAddress => v !== null);
  const references = Buffer.isBuffer(m.headers)
    ? (m.headers.toString("utf8").match(/<[^<>\r\n]+>/g) ?? []).slice(0, 100)
    : [];

  return {
    uid: m.uid,
    modseq: bigIntToDecimalString(m.modseq),
    messageId: typeof env.messageId === "string" ? env.messageId : null,
    inReplyTo: typeof env.inReplyTo === "string" ? env.inReplyTo : null,
    references,
    subject: typeof env.subject === "string" ? env.subject : "",
    from,
    to,
    cc,
    internalDate: toIsoDate(m.internalDate),
    sizeBytes: typeof m.size === "number" ? m.size : null,
    hasAttachments: detectHasAttachments(m.bodyStructure),
    flagSeen: flagsSet.has("\\Seen"),
    flagFlagged: flagsSet.has("\\Flagged"),
    flagAnswered: flagsSet.has("\\Answered"),
    flagDraft: flagsSet.has("\\Draft"),
    keywords: extractKeywords(flagsSet),
  };
}

export function toFlagState(m: FetchMessageObject): SyncFlagState {
  const flagsSet = m.flags instanceof Set ? m.flags : new Set<string>(m.flags ?? []);
  return {
    uid: m.uid,
    modseq: bigIntToDecimalString(m.modseq),
    flagSeen: flagsSet.has("\\Seen"),
    flagFlagged: flagsSet.has("\\Flagged"),
    flagAnswered: flagsSet.has("\\Answered"),
    flagDraft: flagsSet.has("\\Draft"),
    keywords: extractKeywords(flagsSet),
  };
}

function mailboxState(mailbox: { path: string; exists: number; uidValidity: bigint; uidNext?: number; highestModseq?: bigint }): SyncMailboxState {
  return {
    path: mailbox.path,
    exists: mailbox.exists,
    uidValidity: bigIntToDecimalString(mailbox.uidValidity) ?? "0",
    uidNext: typeof mailbox.uidNext === "number" ? mailbox.uidNext : null,
    highestModseq: bigIntToDecimalString(mailbox.highestModseq),
  };
}

function supportsCondstore(client: ImapFlow, mailbox: { noModseq?: boolean; highestModseq?: bigint }): boolean {
  if (mailbox.noModseq === true) return false;
  if (mailbox.highestModseq != null) return true;
  const caps = client.capabilities;
  if (caps && typeof caps.has === "function") {
    if (caps.has("CONDSTORE") || caps.has("QRESYNC")) return true;
  }
  return false;
}

// --------------------------------------------------------------------
// Minimal client contract used by sync ops (tests can inject a mock)
// --------------------------------------------------------------------

export interface SyncClient {
  capabilities: Map<string, boolean | number>;
  getMailboxLock(path: string, opts?: { readOnly?: boolean; description?: string }): Promise<{ path: string; release(): void }>;
  mailbox: { path: string; exists: number; uidValidity: bigint; uidNext?: number; highestModseq?: bigint; noModseq?: boolean } | false;
  fetch(
    range: string | number[],
    query: Record<string, unknown>,
    options?: { uid?: boolean; changedSince?: bigint },
  ): AsyncIterableIterator<FetchMessageObject>;
}

// --------------------------------------------------------------------
// Sync operations (client-injected, testable)
// --------------------------------------------------------------------

export interface InitialSyncResult {
  ok: true;
  mode: "initial";
  mailbox: SyncMailboxState;
  messages: SyncMessage[];
  returned: number;
  oldestReturnedUid: number | null;
  newestReturnedUid: number | null;
}

export async function syncInitial(
  client: SyncClient,
  params: { folderPath: string; limit: number },
): Promise<InitialSyncResult> {
  const lock = await client.getMailboxLock(params.folderPath, { readOnly: true, description: "sync/initial" });
  try {
    const mb = client.mailbox;
    if (!mb) throw new Error("MAILBOX_UNAVAILABLE");
    const state = mailboxState(mb);
    if (mb.exists <= 0) {
      return {
        ok: true, mode: "initial", mailbox: state, messages: [], returned: 0,
        oldestReturnedUid: null, newestReturnedUid: null,
      };
    }

    const startSeq = Math.max(1, mb.exists - params.limit + 1);
    const range = `${startSeq}:${mb.exists}`;

    const collected: SyncMessage[] = [];
    const query = {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      size: true,
          bodyStructure: true, headers: ["references"],
    };
    for await (const msg of client.fetch(range, query, { uid: false })) {
      collected.push(normalizeMessage(msg));
    }
    // Deterministic ordering: newest first (UID desc). We never rely on the
    // library's internal iteration order for the wire contract.
    collected.sort((a, b) => b.uid - a.uid);

    return {
      ok: true, mode: "initial", mailbox: state,
      messages: collected, returned: collected.length,
      oldestReturnedUid: collected.length ? collected[collected.length - 1].uid : null,
      newestReturnedUid: collected.length ? collected[0].uid : null,
    };
  } finally {
    try { lock.release(); } catch { /* noop */ }
  }
}

export type FlagsSyncMode = "condstore" | "reconcile-required" | "not-requested";

export interface IncrementalSyncResult {
  ok: true;
  mode: "incremental";
  resetRequired: false;
  mailbox: SyncMailboxState;
  newMessages: SyncMessage[];
  nextSinceUid: number;
  hasMore: boolean;
  flagsSync: FlagsSyncMode;
  flagChanges: SyncFlagState[];
}

export interface ResetRequiredResult {
  ok: true;
  mode: "incremental" | "reconcile";
  resetRequired: true;
  reason: "UIDVALIDITY_CHANGED";
  mailbox: SyncMailboxState;
}

export async function syncIncremental(
  client: SyncClient,
  params: {
    folderPath: string;
    expectedUidValidity?: string;
    sinceUid: number;
    sinceModseq?: string;
    flagsFromUid?: number;
    flagsToUid?: number;
    limit: number;
  },
): Promise<IncrementalSyncResult | ResetRequiredResult> {
  const lock = await client.getMailboxLock(params.folderPath, { readOnly: true, description: "sync/incremental" });
  try {
    const mb = client.mailbox;
    if (!mb) throw new Error("MAILBOX_UNAVAILABLE");
    const state = mailboxState(mb);

    if (params.expectedUidValidity && state.uidValidity !== params.expectedUidValidity) {
      return { ok: true, mode: "incremental", resetRequired: true, reason: "UIDVALIDITY_CHANGED", mailbox: state };
    }

    const uidNext = typeof mb.uidNext === "number" ? mb.uidNext : mb.exists + 1;
    const currentMaxUid = Math.max(0, uidNext - 1);
    const startUid = params.sinceUid + 1;
    const newMessages: SyncMessage[] = [];
    let nextSinceUid = params.sinceUid;
    let hasMore = false;
    let endUid = 0;

    if (currentMaxUid >= startUid) {
      endUid = Math.min(currentMaxUid, params.sinceUid + params.limit);
      const range = `${startUid}:${endUid}`;
      const query = {
        uid: true, flags: true, envelope: true, headers: ["references"],
        internalDate: true, size: true, bodyStructure: true,
      };
      for await (const msg of client.fetch(range, query, { uid: true })) {
        newMessages.push(normalizeMessage(msg));
      }
      newMessages.sort((a, b) => a.uid - b.uid);
      // Advance the cursor to the end of the requested window, even when the
      // server returned fewer messages (expunged UIDs create gaps).
      nextSinceUid = endUid;
      hasMore = endUid < currentMaxUid;
    }

    // Optional CONDSTORE flag delta over a bounded UID range.
    let flagsSync: FlagsSyncMode = "not-requested";
    const flagChanges: SyncFlagState[] = [];
    const wantsFlagsDelta =
      params.sinceModseq != null && params.flagsFromUid != null && params.flagsToUid != null;

    if (wantsFlagsDelta) {
      if (!supportsCondstore(client as ImapFlow & SyncClient, mb)) {
        flagsSync = "reconcile-required";
      } else {
        let sinceModseqBig: bigint;
        try {
          sinceModseqBig = BigInt(params.sinceModseq!);
        } catch {
          throw new Error("INVALID_MODSEQ");
        }
        const flagRange = `${params.flagsFromUid}:${params.flagsToUid}`;
        const flagQuery = { uid: true, flags: true };
        for await (const msg of client.fetch(flagRange, flagQuery, {
          uid: true,
          changedSince: sinceModseqBig,
        })) {
          flagChanges.push(toFlagState(msg));
        }
        flagsSync = "condstore";
      }
    }

    return {
      ok: true, mode: "incremental", resetRequired: false, mailbox: state,
      newMessages, nextSinceUid, hasMore, flagsSync, flagChanges,
    };
  } finally {
    try { lock.release(); } catch { /* noop */ }
  }
}

export interface ReconcileResult {
  ok: true;
  mode: "reconcile";
  resetRequired: false;
  mailbox: SyncMailboxState;
  states: SyncFlagState[];
}

export async function syncReconcile(
  client: SyncClient,
  params: { folderPath: string; expectedUidValidity: string; fromUid: number; toUid: number },
): Promise<ReconcileResult | ResetRequiredResult> {
  const lock = await client.getMailboxLock(params.folderPath, { readOnly: true, description: "sync/reconcile" });
  try {
    const mb = client.mailbox;
    if (!mb) throw new Error("MAILBOX_UNAVAILABLE");
    const state = mailboxState(mb);

    if (state.uidValidity !== params.expectedUidValidity) {
      return { ok: true, mode: "reconcile", resetRequired: true, reason: "UIDVALIDITY_CHANGED", mailbox: state };
    }

    const states: SyncFlagState[] = [];
    const range = `${params.fromUid}:${params.toUid}`;
    const query = { uid: true, flags: true };
    for await (const msg of client.fetch(range, query, { uid: true })) {
      states.push(toFlagState(msg));
    }
    states.sort((a, b) => a.uid - b.uid);

    return { ok: true, mode: "reconcile", resetRequired: false, mailbox: state, states };
  } finally {
    try { lock.release(); } catch { /* noop */ }
  }
}

// --------------------------------------------------------------------
// Route-level wrappers (own the IMAP connection lifecycle)
// --------------------------------------------------------------------

/** Redacts a stringly-typed IMAP error so it never leaks account / password / server details. */
function safeError(err: unknown): { code: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  // Normalize a couple of common cases into stable codes; strip host/user hints.
  if (/UIDVALIDITY/i.test(raw)) return { code: "UIDVALIDITY_CHANGED", message: "UIDVALIDITY changed" };
  if (/AuthenticationFailure/i.test(raw) || /Invalid credentials/i.test(raw)) {
    return { code: "AUTH_FAILED", message: "IMAP authentication failed" };
  }
  if (/timeout/i.test(raw)) return { code: "IMAP_TIMEOUT", message: "IMAP timeout" };
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|ECONNRESET/i.test(raw)) {
    return { code: "IMAP_UNREACHABLE", message: "IMAP unreachable" };
  }
  if (/Mailbox doesn'?t exist|NONEXISTENT|Mailbox does not exist/i.test(raw)) {
    return { code: "MAILBOX_NOT_FOUND", message: "Mailbox not found" };
  }
  return { code: "SYNC_ERROR", message: "Sync operation failed" };
}

async function withConnection<T>(
  account: MailAccount,
  password: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try { (client as unknown as { close?: () => void }).close?.(); } catch { /* noop */ }
    }
  }
}

export async function runInitialSync(
  account: MailAccount,
  password: string,
  params: { folderPath: string; limit: number },
): Promise<InitialSyncResult> {
  return withConnection(account, password, (client) =>
    syncInitial(client as unknown as SyncClient, params),
  );
}

export async function runIncrementalSync(
  account: MailAccount,
  password: string,
  params: {
    folderPath: string;
    expectedUidValidity?: string;
    sinceUid: number;
    sinceModseq?: string;
    flagsFromUid?: number;
    flagsToUid?: number;
    limit: number;
  },
) {
  return withConnection(account, password, (client) =>
    syncIncremental(client as unknown as SyncClient, params),
  );
}

export async function runReconcileSync(
  account: MailAccount,
  password: string,
  params: { folderPath: string; expectedUidValidity: string; fromUid: number; toUid: number },
) {
  return withConnection(account, password, (client) =>
    syncReconcile(client as unknown as SyncClient, params),
  );
}

export { safeError, V1_MAX_MESSAGES, V1_MAX_RECONCILE_RANGE };
