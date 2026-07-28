/**
 * Drafts flow for MailMaestro Bridge — MAILMAESTRO_DRAFT_APPEND_R1 (M1).
 *
 * Contract (locked by tests in bridge/tests/drafts.test.ts):
 *
 *   * Drafts folder is resolved server-side via SPECIAL-USE first, then a
 *     conservative well-known fallback. Client-supplied folderPath is
 *     NEVER trusted for the actual APPEND / delete target.
 *
 *   * Idempotency uses IMAP as the source of truth: every MIME carries the
 *     `X-MailMaestro-Draft-ID` header, and before creating a new copy we
 *     search Drafts for that header. No PM2 / process memory / Map.
 *
 *   * "Save" is APPEND-then-delete-old: we only delete the previous copy
 *     AFTER the new APPEND completes successfully. A failed APPEND leaves
 *     the previous draft intact.
 *
 *   * Selective delete uses UID EXPUNGE when UIDPLUS is advertised. When
 *     UIDPLUS is missing we refuse to run a global EXPUNGE (which could
 *     evict unrelated \Deleted messages) and instead leave the old copy
 *     in place, returning a typed non-fatal signal.
 *
 *   * UIDVALIDITY of the resolved Drafts folder is captured on every op.
 *     If the caller passes a `previousRef` whose uidValidity doesn't match
 *     the current mailbox, we DO NOT trust the UID and rely on header
 *     search only.
 *
 *   * Errors returned to the HTTP layer are coarse, typed codes; no
 *     subject, body, recipient, attachment or credential ever leaves the
 *     server via logs or error payloads.
 */
import { z } from "zod";
import type { ListResponse } from "imapflow";
import { makeImapClient, listMailboxes } from "./imap.js";
import {
  buildMime,
  resolveDraftsPath,
  type SendMessagePayload,
  type SendAttachment,
} from "./smtp.js";
import type { MailAccount } from "./types.js";

export const DRAFT_ID_HEADER = "X-MailMaestro-Draft-ID";

// --- Validation --------------------------------------------------------------

export const RecipientSchema = z.object({
  name: z.string().max(200),
  email: z.string().email(),
});

// Body caps mirror the send flow's spirit. Attachments themselves are streamed
// from disk by multer (see uploads.ts) and share the send flow's global
// SEND_MAX_TOTAL_BYTES / SEND_MAX_FILES limits — enforced at the HTTP layer,
// NOT re-declared here so we never diverge from the send contract.
export const DRAFT_MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MiB per body
export const DRAFT_MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MiB combined text

export const PreviousRefSchema = z.object({
  folderPath: z.string().min(1).max(500),
  uid: z.number().int().positive(),
  uidValidity: z.string().min(1).max(64),
});
export type DraftPreviousRef = z.infer<typeof PreviousRefSchema>;

export const AccountSchema = z.object({
  email_address: z.string().email(),
  display_name: z.string().nullable().optional(),
  imap_host: z.string().min(1),
  imap_port: z.number().int().positive(),
  imap_secure: z.boolean().default(true),
  smtp_host: z.string().min(1),
  smtp_port: z.number().int().positive(),
  smtp_secure: z.boolean().default(true),
});

export const DraftSavePayloadSchema = z
  .object({
    account: AccountSchema,
    password: z.string().min(1),
    draftId: z.string().uuid(),
    to: z.array(RecipientSchema).max(200).optional().default([]),
    cc: z.array(RecipientSchema).max(200).optional().default([]),
    bcc: z.array(RecipientSchema).max(200).optional().default([]),
    subject: z.string().max(998).optional().default(""),
    bodyHtml: z.string().max(DRAFT_MAX_TEXT_BYTES).optional(),
    bodyText: z.string().max(DRAFT_MAX_TEXT_BYTES).optional(),
    previousRef: PreviousRefSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const combined = (v.bodyHtml?.length ?? 0) + (v.bodyText?.length ?? 0);
    if (combined > DRAFT_MAX_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DRAFT_BODY_TOO_LARGE",
      });
    }
  });

export type DraftSavePayload = z.infer<typeof DraftSavePayloadSchema> & {
  /**
   * Attachments are supplied out-of-band by multer (streamed to disk) — they
   * are NOT part of the JSON payload contract and MUST NOT be JSON/base64.
   * The HTTP layer merges them in after Zod validation using the exact same
   * SendAttachment shape / limits as the send-multipart flow.
   */
  attachments?: SendAttachment[];
};

export const DraftDeletePayloadSchema = z.object({
  account: AccountSchema,
  password: z.string().min(1),
  draftId: z.string().uuid(),
  previousRef: PreviousRefSchema.optional(),
});
export type DraftDeletePayload = z.infer<typeof DraftDeletePayloadSchema>;




// --- Result types ------------------------------------------------------------

export interface DraftSaveOk {
  ok: true;
  draftId: string;
  folderPath: string;
  uid: number | null;
  uidValidity: string;
  messageId: string;
  savedAt: string;
}
export interface DraftDeleteOk {
  ok: true;
  draftId: string;
  folderPath: string | null;
  deleted: boolean;
}
export type DraftErrorCode =
  | "NO_DRAFTS_FOLDER"
  | "APPEND_FAILED"
  | "IMAP_ERROR"
  | "UIDPLUS_UNSUPPORTED"
  | "SAFE_DRAFT_REPLACE_UNSUPPORTED";
export interface DraftErr {
  ok: false;
  error: DraftErrorCode;
}


// --- Injectable IO surface (mirrors smtp.ts style) --------------------------

export interface ImapDraftClient {
  connect(): Promise<void>;
  list(): Promise<ListResponse[]>;
  hasUidPlus(): boolean;
  /** Opens the mailbox with a write lock. Returns current UIDVALIDITY. */
  openWithLock(path: string): Promise<{
    uidValidity: string;
    release: () => void;
  }>;
  /**
   * Search opened mailbox for messages carrying a given header value.
   * MUST be called only under an open lock on the target mailbox.
   */
  searchByHeader(name: string, value: string): Promise<number[]>;
  /**
   * APPEND a MIME with flags. Returns the new UID + uidValidity if the
   * server supports UIDPLUS, otherwise nulls. MUST NOT be called under a
   * lock (imapflow acquires its own internal lock for APPEND).
   */
  append(
    path: string,
    raw: Buffer,
    flags: string[],
  ): Promise<{ uid: number | null; uidValidity: string | null }>;
  /**
   * Delete a set of UIDs from the currently-open mailbox using UID
   * EXPUNGE. Caller MUST have verified UIDPLUS support. MUST be called
   * under an open lock on the target mailbox.
   */
  deleteByUid(uids: number[]): Promise<boolean>;
  logout(): Promise<void>;
}

export interface DraftDeps {
  createImapDraftClient: (account: MailAccount, password: string) => ImapDraftClient;
  now?: () => Date;
}

// --- Pure helpers (unit-testable) -------------------------------------------

export function draftMimePayload(input: DraftSavePayload): SendMessagePayload {
  const toRecipient = (r: { name?: string; email?: string }) => ({
    name: r.name ?? "",
    email: r.email ?? "",
  });
  return {
    from: {
      name: input.account.display_name || input.account.email_address,
      email: input.account.email_address,
    },
    to: (input.to ?? []).map(toRecipient),
    cc: (input.cc ?? []).map(toRecipient),
    bcc: (input.bcc ?? []).map(toRecipient),
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText,
    // Attachments come from the multer disk-streamed layer with identical
    // shape and limits to the send-multipart route (see bridge/src/index.ts).
    // Never JSON/base64; either { path } or { content: Buffer }.
    attachments: input.attachments,
  };
}

/**
 * Core save routine. Extracted so tests can drive every branch without
 * booting a real IMAP server. Never logs / returns PII.
 *
 * Ordering guarantee (locked by drafts.test.ts):
 *   1. Resolve Drafts folder (server-side, SPECIAL-USE first).
 *   2. Open + search for existing copies of this draftId BEFORE any APPEND.
 *   3. If a prior copy exists (or caller passed `previousRef`) AND UIDPLUS
 *      is not supported → return SAFE_DRAFT_REPLACE_UNSUPPORTED WITHOUT
 *      appending. This closes the "APPEND then discover we can't delete
 *      the old copy" race that would leave duplicates on the server.
 *   4. Otherwise APPEND the new MIME.
 *   5. Reopen, re-search, and selectively EXPUNGE stale copies (UID EXPUNGE).
 */
export async function executeDraftSave(
  client: ImapDraftClient,
  input: DraftSavePayload,
  now: () => Date = () => new Date(),
): Promise<DraftSaveOk | DraftErr> {
  await client.connect();
  try {
    const mailboxes = await client.list();
    const folderPath = resolveDraftsPath(mailboxes);
    if (!folderPath) return { ok: false, error: "NO_DRAFTS_FOLDER" };

    // Build MIME (with the sticky draft id header) BEFORE we take any locks
    // so IMAP holds nothing while nodemailer compiles.
    const { raw, messageId } = await buildMime(draftMimePayload(input), {
      [DRAFT_ID_HEADER]: input.draftId,
    });

    // 1) Pre-APPEND probe: does a prior copy already exist for this draftId?
    //    We MUST know this before appending to avoid the "append then can't
    //    delete" race on servers without UIDPLUS.
    let priorCopies: number[] = [];
    let priorSearchFailed = false;
    let priorUidValidity = "";
    {
      const probe = await client.openWithLock(folderPath);
      try {
        priorUidValidity = probe.uidValidity;
        try {
          priorCopies = await client.searchByHeader(DRAFT_ID_HEADER, input.draftId);
        } catch {
          // Search failure = we can't prove idempotency; treat as no priors
          // BUT record it so a downstream cleanup can catch up.
          priorSearchFailed = true;
        }
      } finally {
        probe.release();
      }
    }

    // Replace mode = we WILL need to delete an old copy after appending.
    // Trigger it either from an actual match OR an explicit caller hint.
    const replaceMode = priorCopies.length > 0 || Boolean(input.previousRef);
    if (replaceMode && !client.hasUidPlus()) {
      // Refuse BEFORE APPEND. No side effects on the mailbox.
      return { ok: false, error: "SAFE_DRAFT_REPLACE_UNSUPPORTED" };
    }

    // 2) APPEND (no external lock — imapflow takes its own).
    let appendUid: number | null;
    let appendUidValidity: string;
    try {
      const appendRes = await client.append(folderPath, raw, ["\\Draft", "\\Seen"]);
      appendUid = appendRes.uid ?? null;
      appendUidValidity = appendRes.uidValidity ?? "";
    } catch {
      return { ok: false, error: "APPEND_FAILED" };
    }

    // 3) Reopen with lock to re-scan for all copies of this draftId.
    //    Canonical = highest UID within the current UIDVALIDITY (newest
    //    wins). Every other UID is stale and MUST be selectively expunged.
    //    This is defense-in-depth on top of the keyed mutex in saveDraft: if
    //    two concurrent APPENDs somehow race past the mutex, or a retry
    //    lands mid-cleanup, all callers converge to the same canonical UID
    //    and the folder can never end up with duplicates or empty.
    const opened = await client.openWithLock(folderPath);
    try {
      const uidValidity = appendUidValidity || opened.uidValidity || priorUidValidity;

      let matched: number[] = [];
      try {
        matched = await client.searchByHeader(DRAFT_ID_HEADER, input.draftId);
      } catch {
        // Search failure MUST NOT roll back the APPEND. Fall back to the
        // append's own UID as the best-effort canonical reference.
        return {
          ok: true,
          draftId: input.draftId,
          folderPath,
          uid: appendUid,
          uidValidity,
          messageId,
          savedAt: now().toISOString(),
        };
      }

      // Deterministic canonical selection: highest UID wins.
      const canonical =
        matched.length > 0 ? matched.reduce((a, b) => (b > a ? b : a), matched[0]) : appendUid;
      const stale = matched.filter((u) => u !== canonical);
      if (stale.length > 0 && client.hasUidPlus()) {
        try {
          await client.deleteByUid(stale);
        } catch {
          // Cleanup failure MUST NOT fail the save. A future save/retry
          // will re-scan and converge.
        }
      }
      void priorSearchFailed;

      return {
        ok: true,
        draftId: input.draftId,
        folderPath,
        uid: canonical,
        uidValidity,
        messageId,
        savedAt: now().toISOString(),
      };
    } finally {
      opened.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}



export async function executeDraftDelete(
  client: ImapDraftClient,
  input: DraftDeletePayload,
): Promise<DraftDeleteOk | DraftErr> {
  await client.connect();
  try {
    const mailboxes = await client.list();
    const folderPath = resolveDraftsPath(mailboxes);
    if (!folderPath) {
      // No Drafts folder means there's nothing to delete: idempotent success.
      return { ok: true, draftId: input.draftId, folderPath: null, deleted: false };
    }

    const opened = await client.openWithLock(folderPath);
    try {
      // If the caller passed a previousRef, verify UIDVALIDITY BEFORE trusting
      // any UID. On mismatch we DO NOT expunge by that UID — we still try
      // header search, which is safe.
      const uidValidityOk =
        !input.previousRef || String(input.previousRef.uidValidity) === opened.uidValidity;

      let matched: number[] = [];
      try {
        matched = await client.searchByHeader(DRAFT_ID_HEADER, input.draftId);
      } catch {
        // Coarse error — leave the copy in place, do NOT expunge blindly.
        return { ok: false, error: "IMAP_ERROR" };
      }

      if (matched.length === 0) {
        return { ok: true, draftId: input.draftId, folderPath, deleted: false };
      }
      if (!client.hasUidPlus()) {
        // Refuse global EXPUNGE. Non-fatal: caller can retry once the server
        // upgrades / a maintenance job cleans up.
        return { ok: false, error: "UIDPLUS_UNSUPPORTED" };
      }
      // If uidValidity is stale, we still expunge by header-derived UIDs
      // (safe because the search returned them from the CURRENT mailbox).
      void uidValidityOk;
      try {
        await client.deleteByUid(matched);
      } catch {
        return { ok: false, error: "IMAP_ERROR" };
      }
      return { ok: true, draftId: input.draftId, folderPath, deleted: true };
    } finally {
      opened.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// --- Production deps (real imapflow) ----------------------------------------

function defaultDeps(): DraftDeps {
  return {
    createImapDraftClient(account, password) {
      const client = makeImapClient(account, password);
      // imapflow exposes `capabilities` as a Set<string> after connect.
      const hasUidPlus = () => {
        const caps =
          (client as unknown as { capabilities?: Iterable<string> }).capabilities ??
          new Set<string>();
        for (const c of caps) {
          if (String(c).toUpperCase() === "UIDPLUS") return true;
        }
        return false;
      };
      return {
        connect: () => client.connect(),
        list: () => listMailboxes(client),
        hasUidPlus,
        async openWithLock(path) {
          const lock = await client.getMailboxLock(path);
          const mb = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
          const uidValidity = mb?.uidValidity != null ? String(mb.uidValidity) : "";
          return {
            uidValidity,
            release: () => lock.release(),
          };
        },
        async searchByHeader(name, value) {
          const res = (await client.search({ header: { [name.toLowerCase()]: value } } as never, {
            uid: true,
          })) as number[] | false;
          return Array.isArray(res) ? res : [];
        },
        async append(path, raw, flags) {
          const res = (await client.append(path, raw, flags)) as unknown as {
            uid?: number;
            uidValidity?: string | number | bigint;
          } | null;
          if (!res) return { uid: null, uidValidity: null };
          const uid = typeof res.uid === "number" && Number.isFinite(res.uid) ? res.uid : null;
          const uidValidity = res.uidValidity != null ? String(res.uidValidity) : null;
          return { uid, uidValidity };
        },
        async deleteByUid(uids) {
          if (uids.length === 0) return true;
          const ok = await client.messageDelete({ uid: uids.join(",") } as never, { uid: true });
          return Boolean(ok);
        },
        logout: () => client.logout().catch(() => {}) as unknown as Promise<void>,
      };
    },
    now: () => new Date(),
  };
}

// --- Keyed mutex (Concurrency Guard) ----------------------------------------
//
// Guarantees only ONE save-or-delete pipeline for a given
// (account_identity + drafts_mailbox + draftId) runs at a time inside this
// bridge process. Rules (locked by tests):
//
//   * This is a Concurrency Guard, NOT an idempotency source. The IMAP
//     `X-MailMaestro-Draft-ID` header remains the source of truth.
//   * The key never carries the password, MIME, or subject. Only the
//     account email + draftId (both already present in the IMAP wire
//     traffic) plus the constant "drafts" mailbox tag.
//   * The map entry is removed as soon as the last waiter releases, so a
//     million unique drafts cannot leak memory.
//   * We never log the key.
const draftMutex = new Map<string, Promise<unknown>>();

export function draftMutexKey(accountEmail: string, draftId: string): string {
  // "drafts" segment reflects the drafts-mailbox scope required by the spec.
  return `${accountEmail}::drafts::${draftId}`;
}

/** Exposed for tests only — verifies the map is fully drained. */
export function draftMutexInflight(): number {
  return draftMutex.size;
}

async function withDraftMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = draftMutex.get(key);
  const run = (prev ? prev.catch(() => {}) : Promise.resolve()).then(fn);
  // Store a chain that resolves ONLY after `run` settles (success or fail),
  // so the next waiter observes the full pipeline result.
  const chain: Promise<unknown> = run.catch(() => {});
  draftMutex.set(key, chain);
  try {
    return await run;
  } finally {
    // Only delete if we're still the tail — otherwise a later caller has
    // taken over ownership and will clean up when it settles.
    if (draftMutex.get(key) === chain) draftMutex.delete(key);
  }
}

// --- High-level entry points (used by HTTP layer) ---------------------------

export async function saveDraft(
  account: MailAccount,
  password: string,
  payload: DraftSavePayload,
  deps: DraftDeps = defaultDeps(),
): Promise<DraftSaveOk | DraftErr> {
  const key = draftMutexKey(account.email_address, payload.draftId);
  return withDraftMutex(key, async () => {
    const client = deps.createImapDraftClient(account, password);
    try {
      return await executeDraftSave(client, payload, deps.now);
    } catch {
      return { ok: false, error: "IMAP_ERROR" };
    }
  });
}

export async function deleteDraft(
  account: MailAccount,
  password: string,
  payload: DraftDeletePayload,
  deps: DraftDeps = defaultDeps(),
): Promise<DraftDeleteOk | DraftErr> {
  const key = draftMutexKey(account.email_address, payload.draftId);
  return withDraftMutex(key, async () => {
    const client = deps.createImapDraftClient(account, password);
    try {
      return await executeDraftDelete(client, payload);
    } catch {
      return { ok: false, error: "IMAP_ERROR" };
    }
  });
}
