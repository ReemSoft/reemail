import { ImapFlow, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Readable } from "node:stream";
import type { MailAccount, MailFolder, FolderCount, MailMessage, MailAttachment } from "./types.js";
import {
  getMailboxesCached,
  withAccountMailbox,
  dropAccountConnection,
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

function structureLeaves(structure: any, acc: any[] = []): any[] {
  if (!structure) return acc;
  const mime = String(structure.type || "").toLowerCase();
  if (!mime.startsWith("multipart/")) acc.push(structure);
  const kids = Array.isArray(structure.childNodes)
    ? structure.childNodes
    : structure.childNodes
      ? [structure.childNodes]
      : [];
  for (const c of kids) structureLeaves(c, acc);
  return acc;
}

/**
 * Chooses the displayable body part from BODYSTRUCTURE: text/html first,
 * text/plain otherwise. Attachment-ish leaves (explicit attachment
 * disposition or a filename) are never treated as the body.
 */
export function pickTextPart(structure: any): TextPartPick | null {
  const leaves = structureLeaves(structure);
  const isBody = (n: any) => {
    const disp = n.disposition ? String(n.disposition).toLowerCase() : undefined;
    const filename = n.dispositionParameters?.filename || n.parameters?.name;
    return disp !== "attachment" && !filename;
  };
  const byType = (t: string) =>
    leaves.find((n) => String(n.type || "").toLowerCase() === t && isBody(n));
  const pick = byType("text/html") || byType("text/plain");
  if (!pick) return null;
  return {
    part: pick.part || "1",
    type: String(pick.type || "text/plain").toLowerCase(),
    charset: pick.parameters?.charset,
  };
}

function decodeText(buf: Buffer, charset?: string): string {
  const cs = (charset || "utf-8").toLowerCase().trim();
  try {
    return new TextDecoder(cs as any).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
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
): Promise<{ buf: Buffer; meta: any } | null> {
  const dl = await client.download(String(uid), part, { uid: true, maxBytes });
  if (!dl?.content) return null;
  const chunks: Buffer[] = [];
  try {
    // Consume the stream to the end — ImapFlow already caps it at maxBytes.
    for await (const chunk of dl.content as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (err) {
    try {
      (dl.content as any)?.destroy?.();
    } catch {
      /* already gone */
    }
    onPoisoned?.();
    throw err;
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

export function planInlineImagesForOpen(
  candidates: NonNullable<MailMessage["inlineParts"]>,
  lane: ImapLane,
): {
  deferred: NonNullable<MailMessage["inlineParts"]>;
  toDownload: NonNullable<MailMessage["inlineParts"]>;
} {
  return lane === "interactive"
    ? { deferred: candidates, toDownload: [] }
    : { deferred: [], toDownload: candidates };
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
): Promise<MailMessage | null> {
  const mailboxes = await getMailboxesCached(account, password, lane);
  const path = resolveFolderPath(mailboxes, folder);
  if (!path) return null;

  const tOpen = Date.now();
  const result = await withAccountMailbox(
    account,
    password,
    path,
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
      if (TIMING_ENABLED)
        console.log(`[imap-timing] lane=${lane} fetch-meta ${Date.now() - tFetch}ms`);

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
        const got = await downloadPartBuffer(client, uid, pick.part, 5 * 1024 * 1024, () =>
          dropAccountConnection(account, lane),
        );
        if (got) {
          bodyBytes = got.buf.length;
          const charset =
            pick.charset ||
            /charset="?([\w-]+)"?/i.exec(String(got.meta?.contentType || ""))?.[1] ||
            (got.meta as any)?.charset;
          const text = decodeText(got.buf, charset);
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
      // Interactive opens stop at metadata. Background warming retains its
      // bounded embedding behavior and never runs in the user-facing lane.
      const structural = collectAttachmentParts(msg.bodyStructure);
      const deferredInline: NonNullable<MailMessage["inlineParts"]> = [];
      const embedded: NonNullable<MailMessage["inlineImages"]> = [];

      if (html) {
        const referenced = new Set<string>();
        for (const m of html.matchAll(/cid:([^"'\s>)\\]+)/gi)) {
          referenced.add(m[1].replace(/^<|>$/g, "").toLowerCase());
        }
        const candidates: NonNullable<MailMessage["inlineParts"]> = [];
        for (const cid of referenced) {
          const partInfo = structural.find(
            (a) => (a.contentId || "").replace(/^<|>$/g, "").toLowerCase() === cid,
          );
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
        // MAILMAESTRO_BODY_FIRST_SINGLE_BATCH_CID: the interactive open returns
        // metadata only. CID bytes are fetched after paint by one batch call.
        // Composer-created drafts may contain inline images up to the existing
        // 5 MiB per-file / 10-file / 25 MiB upload limits. Return metadata for
        // those parts so Edit Draft can stream them through the authenticated
        // attachment route. Normal message-open batching remains at 256 KiB.
        const interactiveCandidates =
          folder === "drafts"
            ? candidates
                .filter(
                  (part) =>
                    part.size >= 0 &&
                    part.size <= 5 * 1024 * 1024 &&
                    /^image\/(?:png|jpeg|gif|webp)$/i.test(part.mimeType),
                )
                .slice(0, 10)
                .reduce<typeof candidates>((selected, part) => {
                  const total = selected.reduce((sum, item) => sum + item.size, 0);
                  if (total + part.size <= 25 * 1024 * 1024) selected.push(part);
                  return selected;
                }, [])
            : selectInlineBatchCandidates(candidates);
        const inlinePlan = planInlineImagesForOpen(
          lane === "interactive" ? interactiveCandidates : candidates,
          lane,
        );
        deferredInline.push(...inlinePlan.deferred);

        const tInline = Date.now();
        let spent = 0;
        for (const c of inlinePlan.toDownload) {
          const eligible =
            embedded.length < INLINE_IMAGE_MAX_COUNT &&
            (c.size || 0) <= INLINE_IMAGE_MAX_BYTES &&
            spent + (c.size || 0) <= INLINE_IMAGE_TOTAL_BYTES &&
            /^image\//i.test(c.mimeType);
          if (!eligible) {
            deferredInline.push(c);
            continue;
          }
          try {
            const got = await downloadPartBuffer(client, uid, c.part, INLINE_IMAGE_MAX_BYTES, () =>
              dropAccountConnection(account, lane),
            );
            if (!got || !got.buf.length) {
              deferredInline.push(c);
              continue;
            }
            spent += got.buf.length;
            embedded.push({
              cid: c.cid,
              part: c.part,
              mimeType: c.mimeType,
              size: got.buf.length,
              dataUri: `data:${c.mimeType};base64,${got.buf.toString("base64")}`,
            });
          } catch {
            // Never let one bad part fail the open — fall back to lazy.
            deferredInline.push(c);
          }
        }
        if (TIMING_ENABLED && candidates.length)
          console.log(
            `[imap-timing] lane=${lane} inline-images ${Date.now() - tInline}ms embedded=${embedded.length} deferred=${deferredInline.length} ${spent}B`,
          );
      }

      // ---- attachments: unchanged contract ---------------------------------
      // Deferred cids stay reachable (the lazy route still needs them); cids we
      // already embedded are rendered in the body, so they are not listed twice.
      const embeddedCids = new Set(embedded.map((d) => d.cid));
      const deferredCids = new Set(deferredInline.map((d) => d.cid));
      const visible = structural.filter((a) => {
        const cid = (a.contentId || "").replace(/^<|>$/g, "").toLowerCase();
        if (cid && embeddedCids.has(cid)) return false;
        if (cid && deferredCids.has(cid)) return true;
        if (a.disposition === "inline" && a.contentId) return false;
        return true;
      });

      parsed.attachments = visible;
      parsed.hasAttachments = visible.length > 0;
      if (deferredInline.length) parsed.inlineParts = deferredInline;
      if (embedded.length) parsed.inlineImages = embedded;

      return parsed;
    },
    lane,
  );

  if (TIMING_ENABLED)
    console.log(`[imap-timing] lane=${lane} message-open ${Date.now() - tOpen}ms`);
  return result;
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
): Promise<InlineImageBatchResult> {
  const images: InlineImageData[] = [];
  const failedCids: string[] = [];
  let totalBytes = 0;

  for (const part of candidates) {
    if (totalBytes + part.size > INLINE_IMAGE_TOTAL_BYTES) {
      failedCids.push(part.cid);
      continue;
    }
    try {
      const got = await downloadPartBuffer(client, uid, part.part, INLINE_IMAGE_MAX_BYTES);
      const mimeType = String(got?.meta?.contentType || part.mimeType).toLowerCase();
      if (
        !got?.buf.length ||
        got.buf.length > INLINE_IMAGE_MAX_BYTES ||
        totalBytes + got.buf.length > INLINE_IMAGE_TOTAL_BYTES ||
        !/^image\//i.test(mimeType)
      ) {
        failedCids.push(part.cid);
        continue;
      }
      totalBytes += got.buf.length;
      images.push({
        cid: part.cid,
        part: part.part,
        mimeType,
        size: got.buf.length,
        dataUri: `data:${mimeType};base64,${got.buf.toString("base64")}`,
      });
    } catch {
      failedCids.push(part.cid);
    }
  }

  return { images, failedCids };
}

/**
 * Fetch every eligible CID while holding one mailbox lock on one reused
 * interactive connection. ImapFlow downloads use BODY.PEEK. One bad part is
 * isolated and never fails the remaining images.
 */
export async function getInlineImagesBatch(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  parts: InlinePartMetadata[],
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

  const mailboxes = await getMailboxesCached(account, password, "interactive");
  const path = resolveFolderPath(mailboxes, folder);
  if (!path) return { images: [], failedCids: candidates.map((part) => part.cid) };

  return withAccountMailbox(
    account,
    password,
    path,
    (client) => downloadInlinePartsInMailbox(client, uid, candidates),
    "interactive",
  );
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
    return {
      meta: {
        contentType: (dl.meta as any)?.contentType,
        filename: (dl.meta as any)?.filename,
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

  if (!isMultipart && structure.part) {
    const isAttachment =
      disp === "attachment" ||
      (disp === "inline" && !!filename) ||
      // Fallback: leaf part with a filename but no explicit disposition
      // (common for .zip / application/octet-stream from some clients).
      (!disp && !!filename);

    if (isAttachment) {
      acc.push({
        id: structure.part,
        part: structure.part,
        filename: filename || `attachment_${acc.length + 1}`,
        size: typeof structure.size === "number" ? structure.size : 0,
        mimeType: mime || "application/octet-stream",
        disposition: disp,
        contentId: structure.id,
      });
    }
  }
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

  const body = parsed.html || parsed.textAsHtml || parsed.text || "";
  const preview = makePreview(parsed.text || parsed.subject || "");
  const hasAttachments = parsed.attachments && parsed.attachments.length > 0;
  const attachments = (parsed.attachments || []).map((a, i) => ({
    id: a.checksum || `att_${i}`,
    filename: a.filename || `attachment_${i}`,
    size: a.size,
    mimeType: a.contentType,
  }));

  const { mailedBy, signedBy, security } = extractSecurityHeaders(parsed);

  return {
    id: "",
    threadId: parsed.messageId || "",
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
