import type { ImapFlow } from "imapflow";
import {
  getMailboxesCached,
  withAccountMailbox,
} from "./imap-connection.js";
import {
  assertExpectedUidValidity,
  resolveFolderPath,
} from "./imap.js";
import type { MailAccount, MailFolder } from "./types.js";

export const EML_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export class EmlDownloadTooLargeError extends Error {
  readonly code = "EML_TOO_LARGE";

  constructor() {
    super("EML_TOO_LARGE");
    this.name = "EmlDownloadTooLargeError";
  }
}

/**
 * Fetch the exact RFC822 source for one message.
 *
 * Performance contract:
 * - never called by message-open
 * - never called by body-cache
 * - never called by prefetch/sync
 * - never called by CID hydration
 * - invoked only by the explicit Download EML action
 */
export async function downloadEmlSourceInMailbox(
  client: ImapFlow,
  uid: number,
  expectedUidValidity: string,
  maxBytes = EML_DOWNLOAD_MAX_BYTES,
): Promise<Buffer | null> {
  assertExpectedUidValidity(client, expectedUidValidity);

  // Cheap metadata probe first: no source bytes yet.
  const metadata = await client.fetchOne(
    String(uid),
    { uid: true, size: true },
    { uid: true },
  );

  if (!metadata) return null;

  const returnedUid = Number((metadata as { uid?: unknown }).uid);
  if (returnedUid !== uid) return null;

  const declaredSize = Number((metadata as { size?: unknown }).size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) return null;
  if (declaredSize > maxBytes) throw new EmlDownloadTooLargeError();

  // ImapFlow source:true returns the original RFC822 message bytes.
  const fetched = await client.fetchOne(
    String(uid),
    { uid: true, source: true },
    { uid: true },
  );

  if (!fetched) return null;

  const fetchedUid = Number((fetched as { uid?: unknown }).uid);
  if (fetchedUid !== uid) return null;

  const source = (fetched as { source?: unknown }).source;
  if (!Buffer.isBuffer(source) || source.length === 0) return null;
  if (source.length > maxBytes) throw new EmlDownloadTooLargeError();

  // Never serve a partial/corrupt source as a valid EML.
  if (source.length !== declaredSize) {
    throw new Error("EML_SOURCE_INCOMPLETE");
  }

  return source;
}

export async function downloadEmlSource(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  expectedUidValidity: string,
): Promise<Buffer | null> {
  // Dedicated transfer lane: large EML work cannot queue message-open,
  // CID/media, background sync, or Draft operations.
  const mailboxes = await getMailboxesCached(
    account,
    password,
    "transfer",
  );

  const path = resolveFolderPath(mailboxes, folder);
  if (!path) return null;

  return withAccountMailbox(
    account,
    password,
    path,
    (client) =>
      downloadEmlSourceInMailbox(
        client,
        uid,
        expectedUidValidity,
      ),
    "transfer",
  );
}
