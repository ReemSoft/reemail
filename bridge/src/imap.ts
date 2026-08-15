import {
  ImapFlow,
  type ListResponse,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import iconv from "iconv-lite";
import type { Readable } from "node:stream";
import type { MailAccount, MailFolder, FolderCount, MailMessage, MailAttachment } from "./types.js";
import { normalizeAttachmentFilename } from "./attachment-filename.js";
import { sniffImageMime } from "./image-signature.js";
import {
  getMailboxesCached,
  withAccountMailbox,
  dropAccountConnection,
  MessageOpenSupersededError,
  TIMING_ENABLED,
  type ImapLane,
} from "./imap-connection.js";

const IMAP_TIMEOUT_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Budgets for embedding inline (cid:) images together with the body.
 * Signature logos / banners are typically a few KB each; these caps keep a
 * pathological message (dozens of full-size embedded photos) from ever
 * slowing the open path down. Anything outside the budget stays lazy.
 */
const INLINE_IMAGE_MAX_BYTES = envInt("INLINE_IMAGE_MAX_BYTES", 256 * 1024);
const INLINE_IMAGE_TOTAL_BYTES = envInt("INLINE_IMAGE_TOTAL_BYTES", 1024 * 1024);
const INLINE_IMAGE_MAX_COUNT = envInt("INLINE_IMAGE_MAX_COUNT", 20);
// Transport-level cap on a single inline part's RAW encoded octets. Worst
// valid RFC 2045 quoted-printable for a decoded D-byte part: every octet as
// "=XX" (3 octets) plus a soft line break ("=\r\n") after each line, which RFC
// 2045 allows down to one token per line -> 3D + 3D = 6D raw octets. 6x the
// decoded budget therefore covers every valid encoding (base64 needs only
// ~1.34x), while each FETCH requests cap+1 and treats a returned literal at
// the cap as proof the part was oversized/truncated -- so BODYSTRUCTURE
// declarations are never trusted alone.
const INLINE_IMAGE_ENCODED_MAX_BYTES = INLINE_IMAGE_MAX_BYTES * 6;
const INLINE_IMAGE_MIME_MAX_BYTES = 8 * 1024;
const INLINE_IMAGE_STREAM_MAX_BYTES = 5 * 1024 * 1024;
export const MESSAGE_BODY_MAX_BYTES = 5 * 1024 * 1024;
const MESSAGE_ENTIRE_BODY_HARD_MAX_BYTES = 25 * 1024 * 1024;
export const MESSAGE_ENTIRE_BODY_MAX_BYTES = Math.max(
  MESSAGE_BODY_MAX_BYTES,
  Math.min(
    envInt("MESSAGE_ENTIRE_BODY_MAX_BYTES", 16 * 1024 * 1024),
    MESSAGE_ENTIRE_BODY_HARD_MAX_BYTES,
  ),
);
const INLINE_IMAGE_SAFE_MIME = /^image\/(?:png|jpe?g|gif|webp)$/i;

/**
 * Classifies the fully-consumed output of an ImapFlow-limited body stream.
 *
 * ImapFlow 1.5.0's download `expectedSize` is the RFC822 message size and a
 * BODYSTRUCTURE part size describes encoded source octets. Neither proves the
 * size of the decoded/charset-converted stream, so callers must only provide
 * `provenCompleteBytes` when an independently reliable output size exists.
 */
export function isDownloadedBodyTruncated(input: {
  loadedBytes: number;
  maxBytes: number;
  provenCompleteBytes?: number;
}): boolean {
  const { loadedBytes, maxBytes, provenCompleteBytes } = input;
  if (
    Number.isSafeInteger(provenCompleteBytes) &&
    provenCompleteBytes != null &&
    provenCompleteBytes >= 0
  ) {
    return provenCompleteBytes > loadedBytes;
  }
  return loadedBytes >= maxBytes;
}

export class MessageBodyTooLargeError extends Error {
  readonly code = "MESSAGE_BODY_TOO_LARGE";

  constructor() {
    super("MESSAGE_BODY_TOO_LARGE");
    this.name = "MessageBodyTooLargeError";
  }
}

const WELL_KNOWN_FOLDERS: Record<MailFolder, string[]> = {
  inbox: ["INBOX"],
  sent: ["Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail", "[Gmail]/Sent"],
  drafts: ["Drafts", "[Gmail]/Drafts"],
  spam: ["Spam", "Junk", "Junk E-mail", "[Gmail]/Spam"],
  trash: ["Trash", "Deleted", "Deleted Items", "[Gmail]/Trash", "[Gmail]/Bin"],
  archive: ["Archive", "[Gmail]/All Mail", "[Gmail]/Archive"],
  starred: ["Starred", "[Gmail]/Starred"],
  all: ["All Mail", "[Gmail]/All Mail"],
};

export function makeImapClient(account: MailAccount, password: string) {
  return new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure,
    auth: {
      user: account.email_address,
      pass: password,
    },
    logger: false,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS,
  });
}

export async function listMailboxes(client: ImapFlow): Promise<ListResponse[]> {
  const tree = await client.list();
  return tree;
}

export function resolveFolderPath(
  mailboxes: ListResponse[],
  folder: MailFolder,
): string | undefined {
  // Starred is not a real folder on most IMAP servers — it's the \Flagged
  // flag inside INBOX. Map it to INBOX so per-UID operations (mark read,
  // star/unstar, move, delete, fetch body) target the correct mailbox.
  if (folder === "starred") {
    const inbox = mailboxes.find((m) => m.path.toUpperCase() === "INBOX");
    if (inbox) return inbox.path;
    // Fall back to a real Starred mailbox if the server exposes one (Gmail).
    const gmailStarred = mailboxes.find((m) => m.path.toLowerCase().includes("starred"));
    if (gmailStarred) return gmailStarred.path;
    return "INBOX";
  }

  const candidates = WELL_KNOWN_FOLDERS[folder] || [];

  // Direct path match
  for (const name of candidates) {
    const found = mailboxes.find((m) => m.path.toLowerCase() === name.toLowerCase());
    if (found) return found.path;
  }

  // Case-insensitive includes match
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const found = mailboxes.find((m) => m.path.toLowerCase().includes(lower));
    if (found) return found.path;
  }

  // For "all" fallback to INBOX
  if (folder === "all") return "INBOX";

  return undefined;
}

export async function getFolderCounts(
  account: MailAccount,
  password: string,
): Promise<FolderCount[]> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);

    const allFolders: MailFolder[] = [
      "inbox",
      "starred",
      "sent",
      "drafts",
      "spam",
      "trash",
      "archive",
      "all",
    ];

    const counts: FolderCount[] = [];
    for (const folder of allFolders) {
      // Starred is a virtual folder (\Flagged in INBOX). Always supported.
      if (folder === "starred") {
        const inboxPath = resolveFolderPath(mailboxes, "inbox") || "INBOX";
        try {
          const lock = await client.getMailboxLock(inboxPath);
          try {
            const uids = (await client.search({ flagged: true } as SearchObject, {
              uid: true,
            })) as number[];
            const unseen = (await client.search({ flagged: true, seen: false } as SearchObject, {
              uid: true,
            })) as number[];
            counts.push({
              folder,
              total: uids?.length ?? 0,
              unread: unseen?.length ?? 0,
              supported: true,
              path: inboxPath,
            });
          } finally {
            lock.release();
          }
        } catch {
          counts.push({ folder, total: 0, unread: 0, supported: true, path: inboxPath });
        }
        continue;
      }

      // For `all`, only treat as supported if a real "All Mail" mailbox exists
      // (e.g. Gmail). Otherwise skip to avoid expensive cross-folder aggregation.
      if (folder === "all") {
        const allMailPath = mailboxes.find(
          (m) => /all\s*mail/i.test(m.path) || /\[Gmail\]\/All Mail/i.test(m.path),
        )?.path;
        if (!allMailPath) {
          counts.push({ folder, total: 0, unread: 0, supported: false });
          continue;
        }
        try {
          const status = await client.status(allMailPath, { messages: true, unseen: true });
          counts.push({
            folder,
            total: status.messages ?? 0,
            unread: status.unseen ?? 0,
            supported: true,
            path: allMailPath,
          });
        } catch {
          counts.push({ folder, total: 0, unread: 0, supported: false, path: allMailPath });
        }
        continue;
      }

      const path = resolveFolderPath(mailboxes, folder);
      if (!path) {
        // archive/etc. not present on the server → hide from the UI.
        counts.push({ folder, total: 0, unread: 0, supported: false });
        continue;
      }
      try {
        const status = await client.status(path, { messages: true, unseen: true });
        counts.push({
          folder,
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
          supported: true,
          path,
        });
      } catch {
        counts.push({ folder, total: 0, unread: 0, supported: true, path });
      }
    }
    return counts;
  } finally {
    await client.logout().catch(() => {});
  }
}

export type SortOption = "date-desc" | "date-asc" | "unread-first" | "starred-first";

export async function getMessages(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  options: { limit?: number; offset?: number; sort?: SortOption } = {},
): Promise<MailMessage[]> {
  const client = makeImapClient(account, password);
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const sort: SortOption = options.sort ?? "date-desc";

  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);

    // Resolve mailbox path (starred = \Flagged in INBOX).
    let path: string | undefined;
    let baseCriteria: SearchObject | null = null;
    if (folder === "starred") {
      path = resolveFolderPath(mailboxes, "inbox") || "INBOX";
      baseCriteria = { flagged: true } as SearchObject;
    } else {
      path = resolveFolderPath(mailboxes, folder);
    }
    if (!path) return [];

    const lock = await client.getMailboxLock(path);
    try {
      // Build ordered UID list across the WHOLE folder (not just the loaded page)
      // using cheap server-side SEARCH calls, then paginate + fetch envelopes
      // only for the slice. This keeps the cost O(page) regardless of sort.
      let orderedUids: number[] = [];

      const fastPath = !baseCriteria && (sort === "date-desc" || sort === "date-asc");

      if (fastPath) {
        // Ultra-fast path: use sequence numbers, no SEARCH needed.
        const total = (client.mailbox as any)?.exists ?? 0;
        if (total === 0) return [];
        let start: number;
        let end: number;
        if (sort === "date-desc") {
          start = Math.max(1, total - offset - limit + 1);
          end = Math.max(1, total - offset);
        } else {
          start = Math.min(total, offset + 1);
          end = Math.min(total, offset + limit);
        }
        if (end < start) return [];
        const range = `${start}:${end}`;

        const messages: MailMessage[] = [];
        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyStructure: true,
        })) {
          const parsed = await messageFromFetch(msg, folder, client);
          messages.push(parsed);
        }
        return messages.sort((a, b) =>
          sort === "date-asc" ? (a.date < b.date ? -1 : 1) : a.date < b.date ? 1 : -1,
        );
      }

      // Grouped / filtered sorts (still cheap: SEARCH only returns UIDs).
      const runSearch = async (extra: SearchObject): Promise<number[]> => {
        const crit: SearchObject = baseCriteria
          ? ({ ...(baseCriteria as any), ...(extra as any) } as SearchObject)
          : extra;
        const uids = ((await client.search(crit, { uid: true })) as number[]) || [];
        return uids;
      };

      if (sort === "unread-first" || sort === "starred-first") {
        const primary =
          sort === "unread-first"
            ? await runSearch({ seen: false } as SearchObject)
            : await runSearch({ flagged: true } as SearchObject);
        const secondary =
          sort === "unread-first"
            ? await runSearch({ seen: true } as SearchObject)
            : await runSearch({ flagged: false } as SearchObject);
        // Each group ordered newest-first (UID desc ~ arrival order).
        primary.sort((a, b) => b - a);
        secondary.sort((a, b) => b - a);
        orderedUids = [...primary, ...secondary];
      } else if (baseCriteria) {
        // starred folder with date sort
        const uids = await runSearch({} as SearchObject);
        orderedUids = uids.sort((a, b) => (sort === "date-asc" ? a - b : b - a));
      }

      if (orderedUids.length === 0) return [];
      const slice = orderedUids.slice(offset, offset + limit);
      if (slice.length === 0) return [];

      const messages: MailMessage[] = [];
      for await (const msg of client.fetch(
        slice as any,
        {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        const parsed = await messageFromFetch(msg, folder, client);
        messages.push(parsed);
      }
      // Preserve the server-computed order (slice), not date order.
      const orderIndex = new Map(slice.map((u, i) => [u, i]));
      messages.sort((a, b) => {
        const ai = orderIndex.get(Number(a.id.split(":")[1])) ?? 0;
        const bi = orderIndex.get(Number(b.id.split(":")[1])) ?? 0;
        return ai - bi;
      });
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface TextPartPick {
  part: string;
  type: string;
  charset?: string;
}

function isAttachmentLike(node: MessageStructureObject): boolean {
  const disposition = node.disposition?.toLowerCase();
  const filename =
    node.dispositionParameters?.filename || node.parameters?.filename || node.parameters?.name;
  return disposition === "attachment" || Boolean(filename);
}

function contentId(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || undefined;
}

function textPartPick(node: MessageStructureObject): TextPartPick | null {
  const type = node.type.toLowerCase();
  if ((type !== "text/html" && type !== "text/plain") || isAttachmentLike(node)) {
    return null;
  }
  return {
    part: node.part || "1",
    type,
    charset: node.parameters?.charset,
  };
}

/** Resolves one display representation without crossing MIME branch boundaries. */
function resolveTextPart(node: MessageStructureObject): TextPartPick | null {
  const type = node.type.toLowerCase();

  // An attached multipart is one attachment branch, and an encapsulated
  // message is a separate message. Neither may donate a body to its parent.
  if (isAttachmentLike(node) || type === "message/rfc822") return null;
  if (!type.startsWith("multipart/")) return textPartPick(node);

  const children = node.childNodes || [];
  if (type === "multipart/alternative") {
    let plain: TextPartPick | null = null;
    for (const child of children) {
      const pick = resolveTextPart(child);
      if (pick?.type === "text/html") return pick;
      if (!plain && pick?.type === "text/plain") plain = pick;
    }
    return plain;
  }

  if (type === "multipart/related") {
    const start = contentId(node.parameters?.start);
    if (start) {
      const root = children.find((child) => contentId(child.id) === start);
      if (root) return resolveTextPart(root);
    }
  }

  // multipart/mixed and related-without-a-resolvable-start use MIME order:
  // the first child branch that yields a body is the root representation.
  for (const child of children) {
    const pick = resolveTextPart(child);
    if (pick) return pick;
  }
  return null;
}

/**
 * Chooses the displayable body part from the already-fetched BODYSTRUCTURE.
 * Selection follows MIME container semantics and never crosses an attached
 * branch or an encapsulated message/rfc822 boundary.
 */
export function pickTextPart(structure: MessageStructureObject | undefined): TextPartPick | null {
  return structure ? resolveTextPart(structure) : null;
}

function decodeText(buf: Buffer, charset?: string): string {
  const cs = (charset || "utf-8").toLowerCase().trim();
  if (cs === "utf-8" || cs === "utf8") return new TextDecoder("utf-8").decode(buf);
  if (iconv.encodingExists(cs)) return iconv.decode(buf, cs);
  return new TextDecoder("utf-8").decode(buf);
}

export function decodeDownloadedText(
  buf: Buffer,
  bodyStructureCharset: string | undefined,
  meta: { contentType?: unknown; charset?: unknown } | undefined,
): string {
  const downloadCharset = typeof meta?.charset === "string" ? meta.charset : undefined;
  const contentTypeCharset =
    /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i
      .exec(String(meta?.contentType || ""))
      ?.slice(1)
      .find(Boolean) || undefined;
  // ImapFlow converts known text charsets to UTF-8 while streaming and then
  // reports meta.charset="utf-8". That output charset must win over the
  // source BODYSTRUCTURE declaration or the already-converted bytes are
  // decoded a second time as the legacy charset.
  return decodeText(buf, downloadCharset || contentTypeCharset || bodyStructureCharset);
}

/**
 * Downloads one body part.
 *
 * Truncation is delegated to ImapFlow's own `maxBytes` option: it stops the
 * literal at the right place AND keeps the IMAP command in a consistent
 * state. We never `break` out of the stream ourselves — a half-read literal
 * leaves unread bytes on the shared socket and wedges every later request on
 * that account ("Failed to open message" until the 30s timeout).
 *
 * If the stream errors or is destroyed, the shared per-account connection is
 * considered poisoned and dropped from the cache, so the next request opens a
 * clean session instead of reusing a desynchronised one.
 */
export async function downloadPartBuffer(
  client: ImapFlow,
  uid: number,
  part: string,
  maxBytes: number,
  onPoisoned?: () => void,
  signal?: AbortSignal,
): Promise<{ buf: Buffer; meta: any } | null> {
  const dl = await client.download(String(uid), part, { uid: true, maxBytes });
  if (!dl?.content) return null;
  const content = dl.content as Readable;
  const chunks: Buffer[] = [];
  let poisoned = false;
  const poison = () => {
    if (poisoned) return;
    poisoned = true;
    onPoisoned?.();
  };
  const onAbort = () => {
    const error = Object.assign(new Error("Inline image request aborted"), { code: "ABORT_ERR" });
    content.destroy(error);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    // Consume the stream to the end — ImapFlow already caps it at maxBytes.
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (err) {
    try {
      content.destroy();
    } catch {
      /* already gone */
    }
    poison();
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return { buf: Buffer.concat(chunks), meta: dl.meta };
}

export function selectInlineBatchCandidates(
  candidates: NonNullable<MailMessage["inlineParts"]>,
): NonNullable<MailMessage["inlineParts"]> {
  let totalBytes = 0;
  return candidates
    .filter((part) => {
      if (
        totalBytes + part.size > INLINE_IMAGE_TOTAL_BYTES ||
        part.size < 0 ||
        part.size > INLINE_IMAGE_MAX_BYTES ||
        !/^image\//i.test(part.mimeType)
      ) {
        return false;
      }
      totalBytes += part.size;
      return true;
    })
    .slice(0, INLINE_IMAGE_MAX_COUNT);
}

export function selectInlineMetadataCandidates(
  candidates: NonNullable<MailMessage["inlineParts"]>,
  folder: MailFolder,
): NonNullable<MailMessage["inlineParts"]> {
  const safe = candidates.filter(
    (part) =>
      part.size >= 0 &&
      part.size <= INLINE_IMAGE_STREAM_MAX_BYTES &&
      INLINE_IMAGE_SAFE_MIME.test(part.mimeType),
  );
  if (folder !== "drafts") return safe.slice(0, INLINE_IMAGE_MAX_COUNT);
  return safe.slice(0, 10).reduce<typeof safe>((selected, part) => {
    const total = selected.reduce((sum, item) => sum + item.size, 0);
    if (total + part.size <= 25 * 1024 * 1024) selected.push(part);
    return selected;
  }, []);
}

export function visibleMessageAttachments(
  attachments: MailAttachment[],
  referencedCids: ReadonlySet<string>,
): MailAttachment[] {
  return attachments.filter((attachment) => {
    const cid = (attachment.contentId || "").replace(/^<|>$/g, "").toLowerCase();
    if (cid && referencedCids.has(cid)) return false;
    if (attachment.disposition === "inline" && attachment.contentId) return false;
    return true;
  });
}

/** A malformed message with multiple MIME owners for one CID fails closed. */
export function findUniqueCidAttachment(
  attachments: readonly MailAttachment[],
  cid: string,
): MailAttachment | null {
  const normalized = cid.replace(/^<|>$/g, "").toLowerCase();
  const matches = attachments.filter(
    (attachment) => (attachment.contentId || "").replace(/^<|>$/g, "").toLowerCase() === normalized,
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Inline-image plan for a single message open.
 *
 * Interactive opens stop at CID metadata; the bytes are fetched by one
 * explicit viewer batch after the body has painted. Background prefetch
 * behaves the same way — it warms the body/structure/metadata and must NOT
 * spend 3-15s downloading every CID part on a low-priority lane. CID bytes
 * are only ever fetched when the user actually opens a message.
 */
export function planInlineImagesForOpen(
  candidates: NonNullable<MailMessage["inlineParts"]>,
  _lane: ImapLane,
): {
  deferred: NonNullable<MailMessage["inlineParts"]>;
  toDownload: NonNullable<MailMessage["inlineParts"]>;
} {
  return { deferred: candidates, toDownload: [] };
}

export interface TrustedMailboxHint {
  path: string;
  expectedUidValidity: string;
}

interface MessageMailboxDeps {
  getMailboxes: typeof getMailboxesCached;
  withMailbox: typeof withAccountMailbox;
}

const messageMailboxDeps: MessageMailboxDeps = {
  getMailboxes: getMailboxesCached,
  withMailbox: withAccountMailbox,
};

class MailboxHintUidValidityMismatch extends Error {}

function validTrustedMailboxHint(
  value: TrustedMailboxHint | undefined,
): value is TrustedMailboxHint {
  return Boolean(
    value &&
    value.path.trim() &&
    value.path.length <= 500 &&
    /^[1-9]\d*$/.test(value.expectedUidValidity),
  );
}

/**
 * Select a server-proven physical path without LIST, then verify UIDVALIDITY
 * from the selected mailbox before any FETCH. Invalid/stale hints fall back to
 * the unchanged LIST + canonical resolver path. Errors after the operation
 * starts are never retried, avoiding duplicate FETCH/body downloads.
 */
export async function withMessageMailbox<T>(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  lane: ImapLane,
  hint: TrustedMailboxHint | undefined,
  operation: (client: ImapFlow) => Promise<T>,
  deps: MessageMailboxDeps = messageMailboxDeps,
  shouldStart?: () => boolean,
): Promise<T | null> {
  if (shouldStart && !shouldStart()) throw new MessageOpenSupersededError();
  if (validTrustedMailboxHint(hint)) {
    let operationStarted = false;
    try {
      return await deps.withMailbox(
        account,
        password,
        hint.path,
        async (client) => {
          const selected = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
          const actualUidValidity =
            selected?.uidValidity == null ? "" : String(selected.uidValidity);
          if (actualUidValidity !== hint.expectedUidValidity) {
            throw new MailboxHintUidValidityMismatch();
          }
          operationStarted = true;
          return operation(client);
        },
        lane,
        shouldStart,
      );
    } catch (error) {
      if (operationStarted || !(error instanceof MailboxHintUidValidityMismatch)) {
        // A path/SELECT failure occurs before our callback and is safe to
        // resolve normally. Once the callback starts, do not duplicate I/O.
        if (operationStarted) throw error;
      }
    }
  }

  if (shouldStart && !shouldStart()) throw new MessageOpenSupersededError();
  const mailboxes = await deps.getMailboxes(account, password, lane, shouldStart);
  const path = resolveFolderPath(mailboxes, folder);
  if (!path) return null;
  return deps.withMailbox(account, password, path, operation, lane, shouldStart);
}

/**
 * Opens a single message for display.
 *
 * Performance model (MAILMAESTRO_IMAP_SINGLE_CONNECTION):
 *   * reuses the per-account IMAP connection (no connect/login per click)
 *   * uses the cached LIST response (no LIST per click)
 *   * fetches envelope + flags + bodyStructure + headers, then downloads ONLY
 *     the text/html (or text/plain) part — attachments stay on the server and
 *     keep using the existing protected /api/attachment path
 *   * interactive opens return CID metadata only; one protected batch fetches
 *     their bytes after the text has painted
 *
 * All FETCH/download commands use BODY.PEEK, so opening a message still does
 * NOT change its \Seen flag — read state stays driven by the explicit
 * mark-read call, exactly as before.
 */
export async function getMessageBody(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  lane: ImapLane = "interactive",
  mailboxHint?: TrustedMailboxHint,
  shouldStart?: () => boolean,
): Promise<MailMessage | null> {
  const tOpen = Date.now();
  const result = await withMessageMailbox(
    account,
    password,
    folder,
    lane,
    mailboxHint,
    async (client) => {
      const tFetch = Date.now();
      const msg = await client.fetchOne(
        uid.toString(),
        {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyStructure: true,
          headers: true,
        },
        { uid: true },
      );
      if (!msg) return null;
      if (TIMING_ENABLED) {
        console.log(`[imap-timing] lane=${lane} fetch-meta ${Date.now() - tFetch}ms`);
        // Total waiting incurred before the meta fetch could even start:
        // gate admission + connection reuse/chain + mailbox lock + LIST/path
        // resolution. PII-free stage names and durations only.
        console.log(
          `[imap-timing] lane=${lane} pre-fetch-wait ${Date.now() - tOpen - (Date.now() - tFetch)}ms`,
        );
      }

      // Headers only — cheap, and keeps From/To/Subject/DKIM extraction and the
      // X-MailMaestro-Draft-ID lookup byte-identical to the previous behaviour.
      const rawParsed = await simpleParser(msg.headers as Buffer);
      const parsed = parsedMailToMessage(rawParsed, folder);
      parsed.id = `${folder}:${uid}`;
      parsed.threadId = msg.envelope?.messageId || parsed.id;
      parsed.read = msg.flags?.has("\\Seen") || false;
      parsed.starred = msg.flags?.has("\\Flagged") || false;
      parsed.folder = folder;
      parsed.date = msg.internalDate ? new Date(msg.internalDate).toISOString() : parsed.date;

      const draftIdHeader = headerValue(rawParsed, "X-MailMaestro-Draft-ID").trim();
      if (draftIdHeader) parsed.draftIdHeader = draftIdHeader;
      const mb = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
      if (mb?.uidValidity != null) parsed.uidValidity = String(mb.uidValidity);

      // ---- body: download ONLY the display part -----------------------------
      let bodyBytes = 0;
      const pick = pickTextPart(msg.bodyStructure);
      let html = "";
      if (pick) {
        const tBody = Date.now();
        const got = await downloadPartBuffer(client, uid, pick.part, MESSAGE_BODY_MAX_BYTES, () =>
          dropAccountConnection(account, lane),
        );
        if (got) {
          bodyBytes = got.buf.length;
          if (
            isDownloadedBodyTruncated({
              loadedBytes: bodyBytes,
              maxBytes: MESSAGE_BODY_MAX_BYTES,
            })
          ) {
            parsed.bodyTruncated = true;
          }
          const text = decodeDownloadedText(got.buf, pick.charset, got.meta);
          if (pick.type === "text/html") {
            html = text;
          } else {
            // Reuse mailparser so plain-text → HTML conversion (linkify,
            // paragraphs) matches exactly what the old full-source path produced.
            const mini = await simpleParser(
              `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}`,
            );
            html = mini.textAsHtml || mini.text || "";
            parsed.preview = makePreview(mini.text || rawParsed.subject || "");
          }
        }
        if (TIMING_ENABLED)
          console.log(
            `[imap-timing] lane=${lane} fetch-body ${Date.now() - tBody}ms ${bodyBytes}B`,
          );
      }
      parsed.body = html;

      // ---- inline (cid:) images referenced by THIS html ---------------------
      // ROOT MODEL (MAILMAESTRO_INLINE_IMAGES_IN_SESSION):
      // Every open stops at CID metadata — interactive and background alike.
      // CID bytes are downloaded only after the user actually opens the
      // message, through ONE protected multi-part batch. This is what removes
      // the 3-15s of sequential CID downloads from background prefetch.
      const structural = collectAttachmentParts(msg.bodyStructure);
      const deferredInline: NonNullable<MailMessage["inlineParts"]> = [];
      const referencedCids = new Set<string>();

      if (html) {
        for (const m of html.matchAll(/cid:([^"'\s>)\\]+)/gi)) {
          referencedCids.add(m[1].replace(/^<|>$/g, "").toLowerCase());
        }
        const candidates: NonNullable<MailMessage["inlineParts"]> = [];
        for (const cid of referencedCids) {
          const partInfo = findUniqueCidAttachment(structural, cid);
          if (!partInfo?.part) continue;
          candidates.push({
            cid,
            part: partInfo.part,
            mimeType: partInfo.mimeType || "application/octet-stream",
            size: partInfo.size || 0,
          });
        }

        // Smallest first: the visible signature logos win the budget.
        candidates.sort((a, b) => (a.size || 0) - (b.size || 0));
        // MAILMAESTRO_BODY_FIRST_SINGLE_BATCH_CID: the open returns
        // metadata only — the exact same sanitized set for interactive and
        // background prefetch. CID bytes are fetched after paint by one batch
        // call. Composer-created drafts may contain inline images up to the
        // existing 5 MiB per-file / 10-file / 25 MiB upload limits. Return
        // metadata for those parts so Edit Draft can stream them through the
        // authenticated attachment route. Normal message-open batching stays
        // at 256 KiB.
        const metadataCandidates = selectInlineMetadataCandidates(candidates, folder);
        const inlinePlan = planInlineImagesForOpen(metadataCandidates, lane);
        deferredInline.push(...inlinePlan.deferred);

        if (TIMING_ENABLED && candidates.length)
          console.log(
            `[imap-timing] lane=${lane} inline-metadata deferred=${deferredInline.length} parts`,
          );
      }

      // ---- attachments ------------------------------------------------------
      // HTML-referenced CIDs are body resources. Their inlineParts metadata is
      // sufficient for lazy access; exposing them as attachments duplicates UI.
      const visible = visibleMessageAttachments(structural, referencedCids);

      parsed.attachments = visible;
      parsed.hasAttachments = visible.length > 0;
      if (deferredInline.length) parsed.inlineParts = deferredInline;

      return parsed;
    },
    messageMailboxDeps,
    shouldStart,
  );

  if (TIMING_ENABLED)
    console.log(`[imap-timing] lane=${lane} message-open ${Date.now() - tOpen}ms`);
  return result;
}

/**
 * One Bridge boundary for a bounded visible-message prefetch window. The
 * background lane owns one reusable per-account connection; each unit releases
 * its mailbox lock before the next so interactive work on its separate lane is
 * never queued behind the whole window.
 */
export async function getMessageBodiesBatch(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uids: number[],
  runUnit: <T>(worker: () => Promise<T>) => Promise<T> = (worker) => worker(),
): Promise<Array<{ uid: number; message: MailMessage | null }>> {
  const unique = [...new Set(uids.filter((uid) => Number.isInteger(uid) && uid > 0))].slice(0, 12);
  const results: Array<{ uid: number; message: MailMessage | null }> = [];
  for (const uid of unique) {
    try {
      results.push({
        uid,
        message: await runUnit(() => getMessageBody(account, password, folder, uid, "background")),
      });
    } catch {
      results.push({ uid, message: null });
    }
  }
  return results;
}

export interface EntireMessageBody {
  body: string;
  bodyTruncated: false;
  inlineParts: NonNullable<MailMessage["inlineParts"]>;
  uidValidity: string;
}

/**
 * Explicit, user-triggered large-body read. This deliberately re-downloads
 * the selected MIME part from byte zero: appending to the initial decoded
 * prefix would be unsafe across transfer-encoding and charset boundaries.
 */
export async function downloadEntireBodyInMailbox(
  client: ImapFlow,
  account: MailAccount,
  uid: number,
  folder: MailFolder,
): Promise<EntireMessageBody | null> {
  const msg = await client.fetchOne(
    uid.toString(),
    { uid: true, bodyStructure: true },
    { uid: true },
  );
  if (!msg) return null;

  const mailbox = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
  const uidValidity = mailbox?.uidValidity == null ? "" : String(mailbox.uidValidity);
  const pick = pickTextPart(msg.bodyStructure);
  if (!pick) return { body: "", bodyTruncated: false, inlineParts: [], uidValidity };

  const got = await downloadPartBuffer(client, uid, pick.part, MESSAGE_ENTIRE_BODY_MAX_BYTES, () =>
    dropAccountConnection(account, "interactive"),
  );
  if (!got) return null;
  if (
    isDownloadedBodyTruncated({
      loadedBytes: got.buf.length,
      maxBytes: MESSAGE_ENTIRE_BODY_MAX_BYTES,
    })
  ) {
    throw new MessageBodyTooLargeError();
  }

  const text = decodeDownloadedText(got.buf, pick.charset, got.meta);
  let html = text;
  if (pick.type !== "text/html") {
    const mini = await simpleParser(
      `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}`,
    );
    html = mini.textAsHtml || mini.text || "";
  }

  const structural = collectAttachmentParts(msg.bodyStructure);
  const referencedCids = new Set<string>();
  for (const match of html.matchAll(/cid:([^"'\s>)\\]+)/gi)) {
    referencedCids.add(match[1].replace(/^<|>$/g, "").toLowerCase());
  }
  const candidates: NonNullable<MailMessage["inlineParts"]> = [];
  for (const cid of referencedCids) {
    const partInfo = findUniqueCidAttachment(structural, cid);
    if (!partInfo?.part) continue;
    candidates.push({
      cid,
      part: partInfo.part,
      mimeType: partInfo.mimeType || "application/octet-stream",
      size: partInfo.size || 0,
    });
  }
  candidates.sort((a, b) => (a.size || 0) - (b.size || 0));

  return {
    body: html,
    bodyTruncated: false,
    inlineParts: selectInlineMetadataCandidates(candidates, folder),
    uidValidity,
  };
}

export async function getEntireMessageBody(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  mailboxHint?: TrustedMailboxHint,
): Promise<EntireMessageBody | null> {
  return withMessageMailbox(account, password, folder, "interactive", mailboxHint, (client) =>
    downloadEntireBodyInMailbox(client, account, uid, folder),
  );
}

export type InlinePartMetadata = NonNullable<MailMessage["inlineParts"]>[number];
export type InlineImageData = NonNullable<MailMessage["inlineImages"]>[number];

export interface InlineImageBatchResult {
  images: InlineImageData[];
  failedCids: string[];
}

export async function downloadInlinePartsInMailbox(
  client: ImapFlow,
  uid: number,
  candidates: InlinePartMetadata[],
  expectedUidValidity: string,
): Promise<InlineImageBatchResult> {
  const mailbox = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
  if (mailbox?.uidValidity == null || String(mailbox.uidValidity) !== expectedUidValidity) {
    return { images: [], failedCids: candidates.map((part) => part.cid) };
  }

  // Duplicate Content-IDs that map to different physical parts are ambiguous —
  // we must fail closed instead of guessing which image the body references.
  const owners = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const part of candidates) {
    const cid = part.cid.toLowerCase();
    const owner = `${part.part}\u0000${part.mimeType.toLowerCase()}\u0000${part.size}`;
    const previous = owners.get(cid);
    if (previous !== undefined && previous !== owner) ambiguous.add(cid);
    else owners.set(cid, owner);
  }

  // Select only unambiguous, image parts with a known positive size that fit
  // the per-image, count and total byte budget. Parts we will not fetch are
  // reported as failed so the caller never renders a guess.
  const images: InlineImageData[] = [];
  const failedCids: string[] = [...ambiguous];
  const selected: InlinePartMetadata[] = [];
  const seen = new Set<string>();
  let declaredBytes = 0;
  for (const part of candidates) {
    const cid = part.cid.toLowerCase();
    if (ambiguous.has(cid) || seen.has(cid)) {
      continue;
    }
    seen.add(cid);
    if (
      !/^\d+(?:\.\d+)*$/.test(part.part) ||
      !/^image\//i.test(part.mimeType) ||
      !Number.isInteger(part.size) ||
      part.size <= 0 ||
      part.size > INLINE_IMAGE_MAX_BYTES ||
      selected.length >= INLINE_IMAGE_MAX_COUNT ||
      declaredBytes + part.size > INLINE_IMAGE_TOTAL_BYTES
    ) {
      failedCids.push(part.cid);
      continue;
    }
    declaredBytes += part.size;
    selected.push(part);
  }

  // Fetch every selected part in ONE multi-part UID FETCH. ImapFlow builds
  // BODY.PEEK[section]<0.N> atoms, so no message is ever marked \Seen, and
  // per-part partials give every part a hard transport-level byte cap that is
  // enforced by the server. The whole batch replaces N sequential round trips;
  // each part is still validated against the per-image and total byte budgets
  // after its transfer encoding is decoded.
  if (selected.length) {
    try {
      const response = await client.fetchOne(
        String(uid),
        {
          uid: true,
          bodyParts: selected.flatMap((part) => [
            { key: part.part, maxLength: INLINE_IMAGE_ENCODED_MAX_BYTES + 1 },
            { key: `${part.part}.mime`, maxLength: INLINE_IMAGE_MIME_MAX_BYTES + 1 },
          ]),
        },
        { uid: true },
      );
      if (!response || !response.bodyParts) {
        failedCids.push(...selected.map((part) => part.cid));
      } else {
        let totalBytes = 0;
        for (const part of selected) {
          const raw = response.bodyParts.get(part.part);
          const rawMime = response.bodyParts.get(`${part.part}.mime`);
          if (
            !raw ||
            !raw.length ||
            raw.length >= INLINE_IMAGE_ENCODED_MAX_BYTES + 1 ||
            (rawMime != null && rawMime.length >= INLINE_IMAGE_MIME_MAX_BYTES + 1)
          ) {
            failedCids.push(part.cid);
            continue;
          }
          const mime = parseInlinePartMime(rawMime);
          let decoded: Buffer;
          try {
            decoded = decodeInlinePartContent(raw, mime.transferEncoding ?? "");
          } catch {
            failedCids.push(part.cid);
            continue;
          }
          // Canonicalize the MIME from the actual decoded bytes, never the
          // BODYSTRUCTURE / MIME-header declaration. A part whose real bytes
          // are not one of the four supported raster formats fails closed
          // instead of being promoted by a stale image/* label.
          const mimeType = sniffImageMime(decoded);
          if (
            !mimeType ||
            !decoded.length ||
            decoded.length > INLINE_IMAGE_MAX_BYTES ||
            totalBytes + decoded.length > INLINE_IMAGE_TOTAL_BYTES
          ) {
            failedCids.push(part.cid);
            continue;
          }
          totalBytes += decoded.length;
          images.push({
            cid: part.cid,
            part: part.part,
            mimeType,
            size: decoded.length,
            dataUri: `data:${mimeType};base64,${decoded.toString("base64")}`,
          });
        }
      }
    } catch {
      // A hard FETCH failure fails the whole batch closed; the message body
      // is already painted and the viewer simply retries on a later open.
      failedCids.push(...selected.map((part) => part.cid));
    }
  }

  return { images, failedCids };
}

/** Parses the MIME section of a part for its Content-Type and transfer encoding. */
function parseInlinePartMime(rawMime?: Buffer): {
  contentType?: string;
  transferEncoding?: string;
} {
  if (!rawMime || !rawMime.length) return {};
  const text = rawMime.toString("latin1");
  const clean = (value: string | undefined): string | undefined => {
    const parts = (value ?? "").split(";")[0];
    return parts
      ? parts
          .replace(/\(.*\)/g, "")
          .trim()
          .toLowerCase()
      : undefined;
  };
  return {
    contentType: clean(text.match(/^content-type:\s*([^\r\n]+)/im)?.[1]) || undefined,
    transferEncoding:
      clean(text.match(/^content-transfer-encoding:\s*([^\r\n]+)/im)?.[1]) || undefined,
  };
}

/**
 * Decodes a part's raw literal by its Content-Transfer-Encoding. Mirrors the
 * library's own transfer-decoding behavior (libbase64/libqp) so a cached body
 * and a fresh IMAP fetch decode identically.
 */
function decodeInlinePartContent(raw: Buffer, transferEncoding: string): Buffer {
  switch (transferEncoding) {
    case "base64":
      return Buffer.from(raw.toString("latin1"), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(raw.toString("latin1"));
    default:
      return raw;
  }
}

/** RFC 2045 quoted-printable decoder, byte-for-byte compatible with libqp. */
function decodeQuotedPrintable(str: string): Buffer {
  const cleaned = str.replace(/[\t ]+$/gm, "").replace(/=(?:\r?\n|$)/g, "");
  const hexCount = (cleaned.match(/=[\da-fA-F]{2}/g) ?? []).length;
  const out = Buffer.alloc(cleaned.length - hexCount * 2);
  let pos = 0;
  for (let i = 0, len = cleaned.length; i < len; i++) {
    const chr = cleaned.charAt(i);
    const hex = cleaned.substr(i + 1, 2);
    if (chr === "=" && /[\da-fA-F]{2}/.test(hex)) {
      out[pos++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[pos++] = chr.charCodeAt(0);
    }
  }
  return out;
}

/**
 * Fetch every eligible CID while holding one mailbox lock on one reused media
 * connection. ImapFlow downloads use BODY.PEEK. One bad part is isolated and
 * never fails the remaining images. Media runs on its own lane so image bytes
 * never queue behind (or ahead of) a message-body open.
 */
export async function getInlineImagesBatch(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  parts: InlinePartMetadata[],
  expectedUidValidity: string,
): Promise<InlineImageBatchResult> {
  const candidates = parts
    .filter(
      (part) =>
        /^\d+(?:\.\d+)*$/.test(part.part) &&
        /^image\//i.test(part.mimeType) &&
        part.size >= 0 &&
        part.size <= INLINE_IMAGE_MAX_BYTES,
    )
    .slice(0, INLINE_IMAGE_MAX_COUNT);
  if (!candidates.length) return { images: [], failedCids: [] };

  const mailboxes = await getMailboxesCached(account, password, "media");
  const path = resolveFolderPath(mailboxes, folder);
  if (!path) return { images: [], failedCids: candidates.map((part) => part.cid) };

  return withAccountMailbox(
    account,
    password,
    path,
    (client) => downloadInlinePartsInMailbox(client, uid, candidates, expectedUidValidity),
    "media",
  );
}

export const LARGE_INLINE_PART_MAX_BYTES = 5 * 1024 * 1024;

export interface LargeInlinePartResult {
  bytes: Buffer;
  mimeType: string;
}

export interface LargeInlineBatchImage extends LargeInlinePartResult {
  cid: string;
  part: string;
}

export interface LargeInlineBatchResult {
  images: LargeInlineBatchImage[];
  failedCids: string[];
}

/** One mailbox selection/lock for all deferred large CID parts. */
export async function getLargeInlinePartsBatch(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  parts: InlinePartMetadata[],
  expectedUidValidity: string,
  signal?: AbortSignal,
): Promise<LargeInlineBatchResult> {
  const owners = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const part of parts) {
    const cid = part.cid.toLowerCase();
    const owner = `${part.part}\u0000${part.mimeType.toLowerCase()}\u0000${part.size}`;
    const previous = owners.get(cid);
    if (previous !== undefined && previous !== owner) ambiguous.add(cid);
    else owners.set(cid, owner);
  }
  const seen = new Set<string>();
  const candidates = parts
    .filter((part) => {
      const cid = part.cid.toLowerCase();
      if (ambiguous.has(cid) || seen.has(cid)) return false;
      seen.add(cid);
      return (
        /^\d+(?:\.\d+)*$/.test(part.part) &&
        INLINE_IMAGE_SAFE_MIME.test(part.mimeType) &&
        part.size >= 0 &&
        part.size <= LARGE_INLINE_PART_MAX_BYTES
      );
    })
    .slice(0, INLINE_IMAGE_MAX_COUNT);
  const rejectedCids = [...ambiguous];
  if (!candidates.length) return { images: [], failedCids: rejectedCids };
  const mailboxes = await getMailboxesCached(account, password, "media");
  const path = resolveFolderPath(mailboxes, folder);
  if (!path || signal?.aborted) {
    return { images: [], failedCids: [...rejectedCids, ...candidates.map((part) => part.cid)] };
  }
  return withAccountMailbox(
    account,
    password,
    path,
    async (client) => {
      const mailbox = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
      if (mailbox?.uidValidity == null || String(mailbox.uidValidity) !== expectedUidValidity) {
        return {
          images: [],
          failedCids: [...rejectedCids, ...candidates.map((part) => part.cid)],
        };
      }
      const images: LargeInlineBatchImage[] = [];
      const failedCids: string[] = [...rejectedCids];
      let totalBytes = 0;
      for (const part of candidates) {
        if (signal?.aborted || totalBytes + part.size > 25 * 1024 * 1024) {
          failedCids.push(part.cid);
          continue;
        }
        try {
          const result = await downloadPartBuffer(
            client,
            uid,
            part.part,
            LARGE_INLINE_PART_MAX_BYTES,
            () => dropAccountConnection(account, "media"),
            signal,
          );
          const mimeType = result?.buf ? sniffImageMime(result.buf) : null;
          if (
            !mimeType ||
            !result?.buf.length ||
            result.buf.length > LARGE_INLINE_PART_MAX_BYTES ||
            totalBytes + result.buf.length > 25 * 1024 * 1024
          ) {
            failedCids.push(part.cid);
            continue;
          }
          totalBytes += result.buf.length;
          images.push({ cid: part.cid, part: part.part, mimeType, bytes: result.buf });
        } catch {
          failedCids.push(part.cid);
        }
      }
      return { images, failedCids };
    },
    "media",
  );
}

export interface LargeInlinePartDependencies {
  getMailboxes: typeof getMailboxesCached;
  withMailbox: typeof withAccountMailbox;
  dropConnection: typeof dropAccountConnection;
}

const largeInlinePartDependencies: LargeInlinePartDependencies = {
  getMailboxes: getMailboxesCached,
  withMailbox: withAccountMailbox,
  dropConnection: dropAccountConnection,
};

/** Fetches one automatic large CID through the reused media connection. */
export async function getLargeInlinePart(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  part: string,
  expectedUidValidity: string,
  signal?: AbortSignal,
  dependencies: LargeInlinePartDependencies = largeInlinePartDependencies,
): Promise<LargeInlinePartResult | null> {
  if (!Number.isInteger(uid) || uid <= 0 || !/^\d+(?:\.\d+)*$/.test(part)) return null;
  const mailboxes = await dependencies.getMailboxes(account, password, "media");
  const path = resolveFolderPath(mailboxes, folder);
  if (!path || signal?.aborted) return null;

  const startedAt = Date.now();
  const result = await dependencies.withMailbox(
    account,
    password,
    path,
    (client) => {
      const mailbox = (client as unknown as { mailbox?: { uidValidity?: unknown } }).mailbox;
      if (mailbox?.uidValidity == null || String(mailbox.uidValidity) !== expectedUidValidity) {
        return null;
      }
      return downloadPartBuffer(
        client,
        uid,
        part,
        LARGE_INLINE_PART_MAX_BYTES,
        () => dependencies.dropConnection(account, "media"),
        signal,
      );
    },
    "media",
  );
  if (!result?.buf.length || result.buf.length > LARGE_INLINE_PART_MAX_BYTES) return null;
  const expectedSize = Number(result.meta?.expectedSize);
  if (Number.isFinite(expectedSize) && expectedSize > LARGE_INLINE_PART_MAX_BYTES) return null;
  // Canonicalize the MIME from the actual decoded bytes; a non-image part
  // (or one whose declared type disagreed with the real format) fails closed.
  const mimeType = sniffImageMime(result.buf);
  if (!mimeType) return null;
  if (TIMING_ENABLED) {
    console.log(
      `[imap-timing] lane=media large-inline-part ${Date.now() - startedAt}ms ${result.buf.length}B`,
    );
  }
  return { bytes: result.buf, mimeType };
}

/**
 * Stream a single attachment from IMAP using its BODYSTRUCTURE part number.
 * Returns { meta, content }. Caller is responsible for consuming `content`
 * fully; connection cleanup runs after the stream ends/errors.
 */
export async function downloadAttachment(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  part: string,
  maxBytes: number,
): Promise<{
  meta: {
    contentType?: string;
    filename?: string;
    disposition?: string;
    expectedSize?: number;
  };
  content: Readable;
  cleanup: () => Promise<void>;
} | null> {
  const client = makeImapClient(account, password);
  await client.connect();
  // Fast-path: inbox/starred always live in INBOX — skip the LIST round-trip.
  let path: string | undefined;
  if (folder === "inbox" || folder === "starred") {
    path = "INBOX";
  } else {
    const mailboxes = await listMailboxes(client);
    path = resolveFolderPath(mailboxes, folder);
  }
  if (!path) {
    await client.logout().catch(() => {});
    return null;
  }
  const lock = await client.getMailboxLock(path);
  try {
    const dl = await client.download(uid.toString(), part, { uid: true, maxBytes });
    if (!dl || !dl.content) {
      lock.release();
      await client.logout().catch(() => {});
      return null;
    }
    let released = false;
    const cleanup = async () => {
      if (released) return;
      released = true;
      try {
        lock.release();
      } catch {}
      try {
        await client.logout();
      } catch {}
    };
    dl.content.once("end", () => {
      cleanup().catch(() => {});
    });
    dl.content.once("close", () => {
      cleanup().catch(() => {});
    });
    dl.content.once("error", () => {
      cleanup().catch(() => {});
    });
    const rawFilename = (dl.meta as any)?.filename;
    return {
      meta: {
        contentType: (dl.meta as any)?.contentType,
        filename:
          typeof rawFilename === "string" ? normalizeAttachmentFilename(rawFilename) : undefined,
        disposition: (dl.meta as any)?.disposition,
        expectedSize: (dl.meta as any)?.expectedSize,
      },
      content: dl.content as Readable,
      cleanup,
    };
  } catch (err) {
    try {
      lock.release();
    } catch {}
    await client.logout().catch(() => {});
    throw err;
  }
}

async function messageFromFetch(
  msg: any,
  folder: MailFolder,
  client: ImapFlow,
): Promise<MailMessage> {
  const uid: number = msg.uid;
  const envelope = msg.envelope;
  const date = msg.internalDate
    ? new Date(msg.internalDate).toISOString()
    : new Date().toISOString();
  const attachments = collectAttachmentParts(msg.bodyStructure);
  const hasAttachments = attachments.length > 0;

  const from = addressFromEnvelope(envelope?.from?.[0], accountEmail(client));
  const subject = envelope?.subject || "(بدون موضوع)";
  const preview = "";

  return {
    id: `${folder}:${uid}`,
    threadId: envelope?.messageId || `${folder}:${uid}`,
    folder,
    from,
    to: (envelope?.to || []).map((a: any) => addressFromEnvelope(a, "")),
    cc: (envelope?.cc || []).map((a: any) => addressFromEnvelope(a, "")),
    subject,
    preview,
    body: "",
    date,
    read: msg.flags?.has("\\Seen") || false,
    starred: msg.flags?.has("\\Flagged") || false,
    hasAttachments,
    attachments: hasAttachments ? attachments : undefined,
    labels: [],
  };
}

function accountEmail(client: ImapFlow): string {
  // ImapFlow does not expose the auth user directly; fallback placeholder.
  return (client as any).options?.auth?.user || "";
}

function addressFromEnvelope(addr: any, fallback: string): { name: string; email: string } {
  if (!addr) return { name: "", email: fallback };
  return {
    name: addr.name || "",
    email: addr.address || fallback,
  };
}

/**
 * Walk ImapFlow BODYSTRUCTURE tree and collect every attachment-like part
 * with its IMAP part number (usable directly with client.download(uid, part)).
 * Zero extra round-trips: bodyStructure is already fetched for list/read.
 */
export function collectAttachmentParts(
  structure: any,
  acc: MailAttachment[] = [],
): MailAttachment[] {
  if (!structure) return acc;
  const mime = String(structure.type || "").toLowerCase();
  const isMultipart = mime.startsWith("multipart/");
  const filename =
    structure.dispositionParameters?.filename || structure.parameters?.name || undefined;
  const disp = structure.disposition ? String(structure.disposition).toLowerCase() : undefined;
  const isAttachmentBranch =
    disp === "attachment" ||
    (disp === "inline" && !!filename) ||
    // Fallback: a named branch without an explicit disposition is an
    // attached entity, not an ordinary structural multipart container.
    (!disp && !!filename);

  if (!isMultipart && structure.part) {
    if (isAttachmentBranch) {
      acc.push({
        id: structure.part,
        part: structure.part,
        filename: filename ? normalizeAttachmentFilename(filename) : `attachment_${acc.length + 1}`,
        size: typeof structure.size === "number" ? structure.size : 0,
        mimeType: mime || "application/octet-stream",
        disposition: disp,
        contentId: structure.id,
      });
    }
  }

  // An encapsulated message is a separate physical MIME message. Its node can
  // be one outer attachment (for example original.eml), but its descendants
  // belong to that attached message. Likewise, an attachment-like multipart
  // is one attached entity whose children must not donate files to the outer
  // message. Multipart containers are not exposed because their part number
  // is not a proven standalone attachment download representation.
  if (mime === "message/rfc822" || isAttachmentBranch) return acc;

  if (Array.isArray(structure.childNodes)) {
    for (const c of structure.childNodes) collectAttachmentParts(c, acc);
  } else if (structure.childNodes) {
    collectAttachmentParts(structure.childNodes, acc);
  }
  return acc;
}

function detectAttachments(structure: any): boolean {
  return collectAttachmentParts(structure).length > 0;
}

async function parseMessageSource(source: Buffer, folder: MailFolder): Promise<MailMessage> {
  const parsed = await simpleParser(source);
  return parsedMailToMessage(parsed, folder);
}

export function parsedMailToMessage(parsed: ParsedMail, folder: MailFolder): MailMessage {
  const from = parsed.from ? addressFromAddressObject(parsed.from) : { name: "", email: "" };
  const to = parsed.to ? addressesFromAddressObject(parsed.to) : [];
  const cc = parsed.cc ? addressesFromAddressObject(parsed.cc) : [];
  const replyTo = parsed.replyTo ? addressesFromAddressObject(parsed.replyTo) : [];

  const body = parsed.html || parsed.textAsHtml || parsed.text || "";
  const preview = makePreview(parsed.text || parsed.subject || "");
  const hasAttachments = parsed.attachments && parsed.attachments.length > 0;
  const attachments = (parsed.attachments || []).map((a, i) => ({
    id: a.checksum || `att_${i}`,
    filename: a.filename ? normalizeAttachmentFilename(a.filename) : `attachment_${i}`,
    size: a.size,
    mimeType: a.contentType,
  }));

  const { mailedBy, signedBy, security } = extractSecurityHeaders(parsed);
  const inReplyTo = headerValue(parsed, "In-Reply-To").trim() || undefined;
  const references = headerValue(parsed, "References").match(/<[^<>\r\n]+>/g) ?? [];

  return {
    id: "",
    threadId: parsed.messageId || "",
    inReplyTo,
    references,
    replyTo: replyTo.length ? replyTo : undefined,
    folder,
    from,
    to,
    cc,
    subject: parsed.subject || "(بدون موضوع)",
    preview,
    body,
    date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
    read: parsed.flags?.includes("\\Seen") || false,
    starred: parsed.flags?.includes("\\Flagged") || false,
    hasAttachments,
    attachments,
    labels: [],
    mailedBy,
    signedBy,
    security,
  };
}

function headerValue(parsed: ParsedMail, name: string): string {
  const raw = parsed.headers?.get(name.toLowerCase());
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === "string" ? v : "")).join(" ");
  if (typeof (raw as any).value === "string") return (raw as any).value;
  return "";
}

function headerLines(parsed: ParsedMail, name: string): string[] {
  const target = name.toLowerCase();
  const lines = (parsed.headerLines || []).filter((l: any) => l?.key === target);
  return lines.map((l: any) => String(l.line || "").replace(/^[^:]*:\s*/i, ""));
}

function extractSecurityHeaders(parsed: ParsedMail): {
  mailedBy?: string;
  signedBy?: string;
  security?: string;
} {
  // signed-by: DKIM d=domain
  let signedBy: string | undefined;
  const dkim = headerLines(parsed, "DKIM-Signature").join(" ");
  const dMatch = dkim.match(/(?:^|;|\s)d=([^;\s]+)/i);
  if (dMatch) signedBy = dMatch[1].toLowerCase();

  // mailed-by: from Return-Path domain, or from first Received "by <host>"
  let mailedBy: string | undefined;
  const returnPath = headerValue(parsed, "Return-Path");
  const rpMatch = returnPath.match(/@([A-Za-z0-9.-]+)/);
  if (rpMatch) mailedBy = rpMatch[1].toLowerCase();
  if (!mailedBy) {
    const received = headerLines(parsed, "Received");
    const first = received[received.length - 1] || received[0] || "";
    const byMatch = first.match(/\bby\s+([A-Za-z0-9.-]+)/i);
    if (byMatch) mailedBy = byMatch[1].toLowerCase();
  }

  // security: infer TLS from Received "with ESMTPS" / "using TLS"
  let security: string | undefined;
  const receivedAll = headerLines(parsed, "Received").join(" ");
  if (/\b(ESMTPS|ESMTPSA)\b/i.test(receivedAll) || /\busing TLS/i.test(receivedAll)) {
    const versionMatch = receivedAll.match(/\b(TLS(?:v?1\.\d)?)\b/i);
    security = versionMatch ? `مشفّر (${versionMatch[1].toUpperCase()})` : "مشفّر (TLS)";
  } else if (receivedAll) {
    security = "غير مشفّر";
  }

  return { mailedBy, signedBy, security };
}

function flattenAddressObject(
  obj: AddressObject | AddressObject[],
): { name: string; email: string }[] {
  const arr = Array.isArray(obj) ? obj : [obj];
  const out: { name: string; email: string }[] = [];
  for (const item of arr) {
    if (!item) continue;
    const values = (item as any).value as
      | Array<{ name?: string; address?: string; group?: any[] }>
      | undefined;
    if (Array.isArray(values) && values.length) {
      for (const v of values) {
        if (v?.address || v?.name) {
          out.push({ name: v.name || "", email: v.address || "" });
        }
      }
    } else if ((item as any).address || (item as any).name) {
      out.push({ name: (item as any).name || "", email: (item as any).address || "" });
    }
  }
  return out;
}

function addressFromAddressObject(obj: AddressObject): { name: string; email: string } {
  return flattenAddressObject(obj)[0] || { name: "", email: "" };
}

function addressesFromAddressObject(
  obj: AddressObject | AddressObject[],
): { name: string; email: string }[] {
  return flattenAddressObject(obj);
}

function makePreview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
}

export async function markRead(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  read: boolean,
): Promise<void> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) throw new Error("Folder not found");
    const lock = await client.getMailboxLock(path);
    try {
      if (read) {
        await client.messageFlagsAdd({ uid: [uid] } as any, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove({ uid: [uid] } as any, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function starMessage(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  starred: boolean,
): Promise<void> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) throw new Error("Folder not found");
    const lock = await client.getMailboxLock(path);
    try {
      if (starred) {
        await client.messageFlagsAdd({ uid: [uid] } as any, ["\\Flagged"], { uid: true });
      } else {
        await client.messageFlagsRemove({ uid: [uid] } as any, ["\\Flagged"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Result of a Bridge move operation.
 *
 * `uidMappingAvailable` is true iff the IMAP server responded to the
 * MOVE/COPY with UIDPLUS COPYUID data (per RFC 4315). When true, we surface
 * the destination path, the destination UID that the message landed on,
 * and the destination UIDVALIDITY. When false (no UIDPLUS support), we
 * NEVER invent a destination UID — the caller must schedule a targeted
 * destination sync to discover it.
 *
 * `destinationPath` is included even in the no-mapping case because it is
 * resolved locally from the account's folder listing and does not depend
 * on server support.
 */
export interface MoveResult {
  sourceUid: number;
  destinationPath?: string;
  destinationUid?: number;
  destinationUidValidity?: string;
  uidMappingAvailable: boolean;
}

export async function moveMessage(
  account: MailAccount,
  password: string,
  fromFolder: MailFolder,
  uid: number,
  toFolder: MailFolder,
): Promise<MoveResult> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const fromPath = resolveFolderPath(mailboxes, fromFolder);
    const toPath = resolveFolderPath(mailboxes, toFolder);
    if (!fromPath || !toPath) throw new Error("Folder not found");
    const lock = await client.getMailboxLock(fromPath);
    try {
      const raw = (await client.messageMove({ uid: String(uid) } as any, toPath, {
        uid: true,
      })) as unknown;
      return parseMoveResponse(raw, uid, toPath);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Pure decoder for imapflow's messageMove return value. Exported for tests.
 * Never invents a destination UID — a missing / malformed uidMap produces
 * `uidMappingAvailable: false`, and the caller is expected to fall back to
 * a targeted destination sync.
 */
export function parseMoveResponse(
  raw: unknown,
  sourceUid: number,
  fallbackPath: string,
): MoveResult {
  let destinationUid: number | undefined;
  let destinationUidValidity: string | undefined;
  let destinationPath: string | undefined = fallbackPath;
  let uidMappingAvailable = false;

  if (raw && typeof raw === "object") {
    const r = raw as {
      path?: unknown;
      uidMap?: unknown;
      uidValidity?: unknown;
    };
    if (typeof r.path === "string" && r.path.length > 0) destinationPath = r.path;
    if (r.uidValidity != null) destinationUidValidity = String(r.uidValidity);
    const map = r.uidMap;
    let mapped: number | undefined;
    if (map instanceof Map) {
      const v = (map as Map<unknown, unknown>).get(sourceUid);
      if (typeof v === "number") mapped = v;
      else if (typeof v === "bigint") mapped = Number(v);
      else if (typeof v === "string" && /^\d+$/.test(v)) mapped = Number(v);
    } else if (map && typeof map === "object") {
      const rec = map as Record<string, unknown>;
      const v = rec[String(sourceUid)];
      if (typeof v === "number") mapped = v;
      else if (typeof v === "string" && /^\d+$/.test(v)) mapped = Number(v);
    }
    if (typeof mapped === "number" && Number.isFinite(mapped) && mapped > 0) {
      destinationUid = mapped;
      uidMappingAvailable = true;
    }
  }

  return {
    sourceUid,
    destinationPath,
    destinationUid,
    destinationUidValidity,
    uidMappingAvailable,
  };
}

/**
 * Delete-mode routing contract (Blocker 1).
 *
 *   folder === "trash"  → permanent-delete via IMAP `messageDelete` (STORE
 *                         \Deleted + EXPUNGE). NEVER calls `messageMove`.
 *   any other folder    → move-to-trash via `messageMove(..., "trash")`.
 *
 * The pure `decideDeleteMode` helper exists so the routing invariant is
 * unit-testable without a live IMAP server.
 */
export type DeleteMode = "permanent" | "trash";
export function decideDeleteMode(folder: MailFolder): DeleteMode {
  return folder === "trash" ? "permanent" : "trash";
}

export type DeleteResult =
  | { kind: "moved-to-trash"; move: MoveResult }
  | { kind: "permanent-delete"; sourceUid: number };

/**
 * Testable core of the permanent-delete flow. Kept free of connection /
 * mailbox-resolution concerns so unit tests can inject a fake IMAP client
 * that records `messageDelete` vs `messageMove` calls and lock lifecycle.
 *
 * Invariants proven by tests:
 *   * messageDelete calls === 1
 *   * messageMove   calls === 0
 *   * lock.release  calls === 1 (even when messageDelete throws / returns false)
 */
export interface PermanentDeleteImapClient {
  getMailboxLock(path: string): Promise<{ release: () => void }>;
  messageDelete(query: unknown, options: { uid: true }): Promise<boolean>;
}

export async function executePermanentDelete(
  client: PermanentDeleteImapClient,
  path: string,
  uid: number,
): Promise<{ kind: "permanent-delete"; sourceUid: number }> {
  const lock = await client.getMailboxLock(path);
  try {
    const ok = await client.messageDelete({ uid: String(uid) }, { uid: true });
    if (!ok) throw new Error("IMAP messageDelete returned false");
    return { kind: "permanent-delete", sourceUid: uid };
  } finally {
    lock.release();
  }
}

export async function permanentDeleteMessage(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
): Promise<{ kind: "permanent-delete"; sourceUid: number }> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);
    const path = resolveFolderPath(mailboxes, folder);
    if (!path) throw new Error("Folder not found");
    return await executePermanentDelete(client as unknown as PermanentDeleteImapClient, path, uid);
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function deleteMessage(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
): Promise<DeleteResult> {
  if (decideDeleteMode(folder) === "permanent") {
    return permanentDeleteMessage(account, password, folder, uid);
  }
  const move = await moveMessage(account, password, folder, uid, "trash");
  return { kind: "moved-to-trash", move };
}

export async function verifyCredentials(
  account: MailAccount,
  password: string,
): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
  const client = makeImapClient(account, password);
  try {
    await client.connect();
    return { ok: true, displayName: account.display_name || account.email_address };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.responseText || err?.message || "فشل الاتصال بخادم البريد",
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Server-side search (IMAP SEARCH — matches the Roundcube/RFC 3501 approach).
// Default scope: subject + from + to + cc (headers only, near-instant on any
// modern IMAP server, no BODY parsing). When `includeBody` is true we also
// include IMAP BODY, which asks the server to scan message bodies — slower
// but correct. Uses server-side ESEARCH transparently via imapflow when the
// server supports it. Returns at most `limit` newest matches with envelopes.
// ---------------------------------------------------------------------------

function orChain(items: SearchObject[]): SearchObject {
  if (items.length === 0) return {} as SearchObject;
  if (items.length === 1) return items[0];
  return { or: [items[0], orChain(items.slice(1))] } as unknown as SearchObject;
}

export async function searchMessages(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  query: string,
  options: { includeBody?: boolean; limit?: number } = {},
): Promise<MailMessage[]> {
  const q = (query || "").trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const includeBody = !!options.includeBody;

  const client = makeImapClient(account, password);
  try {
    await client.connect();
    const mailboxes = await listMailboxes(client);

    // Starred is virtual (\Flagged in INBOX) — search there.
    let path: string | undefined;
    let extraCriteria: SearchObject | null = null;
    if (folder === "starred") {
      path = resolveFolderPath(mailboxes, "inbox") || "INBOX";
      extraCriteria = { flagged: true } as SearchObject;
    } else {
      path = resolveFolderPath(mailboxes, folder);
    }
    if (!path) return [];

    const branches: SearchObject[] = [
      { header: { subject: q } } as unknown as SearchObject,
      { header: { from: q } } as unknown as SearchObject,
      { header: { to: q } } as unknown as SearchObject,
      { header: { cc: q } } as unknown as SearchObject,
    ];
    if (includeBody) {
      branches.push({ body: q } as SearchObject);
    }

    const criteria: SearchObject = extraCriteria
      ? ({ ...extraCriteria, ...(orChain(branches) as any) } as SearchObject)
      : orChain(branches);

    const lock = await client.getMailboxLock(path);
    try {
      const uids = ((await client.search(criteria, { uid: true })) as number[]) || [];
      if (uids.length === 0) return [];
      const sorted = uids
        .slice()
        .sort((a, b) => b - a)
        .slice(0, limit);

      const messages: MailMessage[] = [];
      for await (const msg of client.fetch(
        sorted as any,
        {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        const parsed = await messageFromFetch(msg, folder, client);
        messages.push(parsed);
      }
      return messages.sort((a, b) => (a.date < b.date ? 1 : -1));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Sender-folder historical pagination. This deliberately stays separate from
// generic search: it advances through the server UID search space and fetches
// metadata for one bounded page, never bodies or message sources.
// ---------------------------------------------------------------------------

export interface SenderMessagesCursor {
  beforeUid: number;
  uidValidity: string;
}

export interface SenderMessagesPage {
  messages: MailMessage[];
  nextCursor: SenderMessagesCursor | null;
  hasMore: boolean;
  cursorReset: boolean;
}

const SENDER_HISTORY_CACHE_TTL_MS = 2 * 60_000;
const SENDER_HISTORY_CACHE_MAX_ENTRIES = 32;
const SENDER_HISTORY_CACHE_MAX_UIDS = 100_000;

interface SenderHistoryUidCacheEntry {
  expiresAt: number;
  uids: number[];
}

const senderHistoryUidCache = new Map<string, SenderHistoryUidCacheEntry>();
let senderHistoryCachedUidCount = 0;

function deleteSenderHistoryCacheEntry(key: string): void {
  const entry = senderHistoryUidCache.get(key);
  if (!entry) return;
  senderHistoryCachedUidCount -= entry.uids.length;
  senderHistoryUidCache.delete(key);
}

function pruneSenderHistoryUidCache(now: number): void {
  for (const [key, entry] of senderHistoryUidCache) {
    if (entry.expiresAt <= now) deleteSenderHistoryCacheEntry(key);
  }
}

function readSenderHistoryUidCache(key: string, now: number): number[] | null {
  pruneSenderHistoryUidCache(now);
  const entry = senderHistoryUidCache.get(key);
  if (!entry) return null;
  senderHistoryUidCache.delete(key);
  senderHistoryUidCache.set(key, entry);
  return entry.uids;
}

function writeSenderHistoryUidCache(key: string, uids: number[], now: number): void {
  pruneSenderHistoryUidCache(now);
  deleteSenderHistoryCacheEntry(key);
  if (uids.length > SENDER_HISTORY_CACHE_MAX_UIDS) return;
  while (
    senderHistoryUidCache.size >= SENDER_HISTORY_CACHE_MAX_ENTRIES ||
    senderHistoryCachedUidCount + uids.length > SENDER_HISTORY_CACHE_MAX_UIDS
  ) {
    const oldestKey = senderHistoryUidCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    deleteSenderHistoryCacheEntry(oldestKey);
  }
  senderHistoryUidCache.set(key, {
    expiresAt: now + SENDER_HISTORY_CACHE_TTL_MS,
    uids,
  });
  senderHistoryCachedUidCount += uids.length;
}

export function resetSenderHistoryUidCacheForTests(): void {
  senderHistoryUidCache.clear();
  senderHistoryCachedUidCount = 0;
}

export function senderHistoryUidCacheStats(): {
  entries: number;
  cachedUids: number;
  maxEntries: number;
  maxCachedUids: number;
  ttlMs: number;
} {
  return {
    entries: senderHistoryUidCache.size,
    cachedUids: senderHistoryCachedUidCount,
    maxEntries: SENDER_HISTORY_CACHE_MAX_ENTRIES,
    maxCachedUids: SENDER_HISTORY_CACHE_MAX_UIDS,
    ttlMs: SENDER_HISTORY_CACHE_TTL_MS,
  };
}

function hasImapCapability(client: ImapFlow, capability: string): boolean {
  const wanted = capability.toUpperCase();
  for (const [key, enabled] of client.capabilities) {
    if (key.toUpperCase() === wanted) return enabled !== false;
  }
  return false;
}

export function supportsSenderHistoryPartialSearch(client: ImapFlow): boolean {
  const rev2Active =
    client.enabled.has("IMAP4REV2") ||
    (hasImapCapability(client, "IMAP4REV2") && !hasImapCapability(client, "IMAP4REV1"));
  return (
    hasImapCapability(client, "PARTIAL") && (hasImapCapability(client, "ESEARCH") || rev2Active)
  );
}

function parseBoundedUidSet(value: unknown, maxItems: number): number[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const result = new Set<number>();
  const add = (uid: number): boolean => {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) return false;
    result.add(uid);
    return result.size < maxItems;
  };
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (/^\d+$/.test(part)) {
      if (!add(Number(part))) break;
      continue;
    }
    const match = /^(\d+):(\d+)$/.exec(part);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (![start, end].every((uid) => Number.isSafeInteger(uid) && uid > 0)) continue;
    const step = start <= end ? 1 : -1;
    for (let uid = start; ; uid += step) {
      if (!add(uid) || uid === end) break;
    }
    if (result.size >= maxItems) break;
  }
  return [...result];
}

function normalizeSenderHistoryUids(rawUids: readonly number[], beforeUid?: number): number[] {
  return [...new Set(rawUids)]
    .filter(
      (uid) => Number.isInteger(uid) && uid > 0 && (beforeUid === undefined || uid < beforeUid),
    )
    .sort((a, b) => b - a);
}

export async function getSenderMessagesPageInMailbox(
  client: ImapFlow,
  sender: string,
  limit: number,
  cursor?: SenderMessagesCursor,
  cacheScope?: string,
): Promise<SenderMessagesPage> {
  const normalizedSender = sender.trim().toLowerCase();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const mailbox = client.mailbox;
  const uidValidity = mailbox ? String(mailbox.uidValidity) : "";
  if (!uidValidity) throw new Error("Inbox UIDVALIDITY unavailable");

  // UID cursors are invalid after UIDVALIDITY changes. Restart safely; the UI
  // deduplicates any overlap with messages that are already rendered.
  const cursorReset = !!cursor && cursor.uidValidity !== uidValidity;
  const beforeUid = cursorReset ? undefined : cursor?.beforeUid;
  if (beforeUid !== undefined && beforeUid <= 1) {
    return { messages: [], nextCursor: null, hasMore: false, cursorReset };
  }

  const criteria = {
    from: normalizedSender,
    ...(beforeUid !== undefined ? { uid: `1:${beforeUid - 1}` } : {}),
  } as unknown as SearchObject;
  const candidateLimit = boundedLimit + 1;
  let orderedUids: number[];
  if (supportsSenderHistoryPartialSearch(client)) {
    const result = await client.search(criteria, {
      uid: true,
      returnOptions: [{ partial: `-1:-${candidateLimit}` }],
    });
    if (!result || Array.isArray(result) || !("partial" in result)) {
      throw new Error("Sender history PARTIAL search failed");
    }
    orderedUids = normalizeSenderHistoryUids(
      parseBoundedUidSet(result.partial?.messages, candidateLimit),
      beforeUid,
    );
  } else {
    const cacheKey = cacheScope ? `${cacheScope}|${uidValidity}|${normalizedSender}` : null;
    const now = Date.now();
    const cachedUids = cacheKey ? readSenderHistoryUidCache(cacheKey, now) : null;
    if (cachedUids) {
      orderedUids = normalizeSenderHistoryUids(cachedUids, beforeUid);
    } else {
      // A cache fill is always mailbox-complete for this sender. Otherwise a
      // mid-pagination fill could later serve an initial page with newer UIDs
      // missing from the cached set.
      const result = await client.search(
        cacheKey ? ({ from: normalizedSender } as unknown as SearchObject) : criteria,
        { uid: true },
      );
      if (!result || !Array.isArray(result)) throw new Error("Sender history search failed");
      const searchedUids = normalizeSenderHistoryUids(result);
      if (cacheKey) writeSenderHistoryUidCache(cacheKey, searchedUids, now);
      orderedUids = normalizeSenderHistoryUids(searchedUids, beforeUid);
    }
  }
  const pageUids = orderedUids.slice(0, boundedLimit);
  if (pageUids.length === 0) {
    return { messages: [], nextCursor: null, hasMore: false, cursorReset };
  }

  const byUid = new Map<number, MailMessage>();
  for await (const msg of client.fetch(
    pageUids,
    {
      uid: true,
      envelope: true,
      internalDate: true,
      flags: true,
      bodyStructure: true,
    },
    { uid: true },
  )) {
    const parsed = await messageFromFetch(msg, "inbox", client);
    if ((parsed.from?.email || "").trim().toLowerCase() === normalizedSender) {
      byUid.set(Number(msg.uid), parsed);
    }
  }

  const messages = pageUids.flatMap((uid) => {
    const message = byUid.get(uid);
    return message ? [message] : [];
  });
  const hasMore = orderedUids.length > pageUids.length;
  const nextCursor = hasMore ? { beforeUid: pageUids[pageUids.length - 1]!, uidValidity } : null;
  return { messages, nextCursor, hasMore, cursorReset };
}

export async function getSenderMessagesPage(
  account: MailAccount,
  password: string,
  sender: string,
  limit: number,
  cursor?: SenderMessagesCursor,
): Promise<SenderMessagesPage> {
  const cacheScope = `${account.imap_host.trim().toLowerCase()}:${account.imap_port}|${account.email_address.trim().toLowerCase()}`;
  return withAccountMailbox(
    account,
    password,
    "INBOX",
    (client) => getSenderMessagesPageInMailbox(client, sender, limit, cursor, cacheScope),
    "background",
  );
}
